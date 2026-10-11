require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const { rateLimit } = require('express-rate-limit');
const pincodeLookup = require('india-pincode-lookup');

sharp.concurrency(1);
sharp.cache(false);

const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.set('trust proxy', 1);

const DATABASE_URL = process.env.DATABASE_URL;

if (process.env.NODE_ENV === 'production' && !DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured in production.');
}

const pool = new Pool({
  connectionString: DATABASE_URL || 'postgresql://rtoboss_user:CHANGE_ME@localhost:5432/rtoboss_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Error]:', err.message);
});

const ADMIN_MASTER_SECRET = process.env.ADMIN_MASTER_SECRET;
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN || (
  ADMIN_MASTER_SECRET
    ? crypto.createHmac('sha256', 'RTO_BOSS_STATIC_SALT').update(String(ADMIN_MASTER_SECRET).trim()).digest('hex')
    : crypto.randomBytes(32).toString('hex')
);

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

const SUREPASS_BASE_URL = process.env.SUREPASS_BASE_URL || 'https://kyc-api.surepass.app';
const SUREPASS_BEARER_TOKEN = process.env.SUREPASS_BEARER_TOKEN || '';

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 12000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...rest, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || '';
const MSG91_WIDGET_ID = process.env.MSG91_WIDGET_ID || '3669776c5531333237393636';
const MSG91_TOKEN_AUTH = process.env.MSG91_TOKEN_AUTH || '';

const allowedOrigins = [
  'https://rtoboss.in', 'https://www.rtoboss.in', 'http://rtoboss.in', 'http://www.rtoboss.in',
  'http://localhost:3000', 'http://127.0.0.1:3000', 'http://187.126.113.210:3000', 'http://187.126.113.210'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Cross-origin request blocked by security policy.'));
  },
  credentials: false
}));

app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  const publicIndexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndexPath)) return res.sendFile(publicIndexPath);
  const rootIndexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndexPath)) return res.sendFile(rootIndexPath);
  return res.status(404).send('Not Found');
});

app.get('/admin', (req, res) => {
  const publicAdminPath = path.join(__dirname, 'public', 'admin.html');
  if (fs.existsSync(publicAdminPath)) return res.sendFile(publicAdminPath);
  const rootAdminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(rootAdminPath)) return res.sendFile(rootAdminPath);
  return res.status(404).send('Not Found');
});

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/', generalLimiter);

const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 1 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });

const orders = new Map();
const otpStore = new Map();
const customers = new Map();

const STATE_NAMES = {
  AN: 'ANDAMAN AND NICOBAR', AP: 'ANDHRA PRADESH', AR: 'ARUNACHAL PRADESH', AS: 'ASSAM',
  BR: 'BIHAR', CG: 'CHHATTISGARH', CH: 'CHANDIGARH', DD: 'DAMAN AND DIU', DL: 'DELHI',
  DN: 'DADRA AND NAGAR HAVELI', GA: 'GOA', GJ: 'GUJARAT', HP: 'HIMACHAL PRADESH', HR: 'HARYANA',
  JH: 'JHARKHAND', JK: 'JAMMU AND KASHMIR', KA: 'KARNATAKA', KL: 'KERALA', LA: 'LADAKH',
  LD: 'LAKSHADWEEP', MH: 'MAHARASHTRA', ML: 'MEGHALAYA', MN: 'MANIPUR', MP: 'MADHYA PRADESH',
  MZ: 'MIZORAM', NL: 'NAGALAND', OD: 'ODISHA', PB: 'PUNJAB', PY: 'PUDUCHERRY', RJ: 'RAJASTHAN',
  SK: 'SIKKIM', TN: 'TAMIL NADU', TR: 'TRIPURA', TS: 'TELANGANA', UK: 'UTTARAKHAND', UP: 'UTTAR PRADESH', WB: 'WEST BENGAL'
};

function maskEvenly(str) {
  if (!str) return '••••••••';
  const clean = String(str).trim();
  if (clean.length <= 4) return '•'.repeat(clean.length);
  const chars = clean.split('');
  const masked = chars.map((char, index) => {
    if (char === ' ' || char === '-' || char === '/') return char;
    if (index % 2 === 0 && index > 0 && index < clean.length - 1) return '•';
    return char;
  });
  let result = masked.join('');
  if (result.length > 6) {
    return result.slice(0, 2) + '••••' + result.slice(-2);
  }
  return result;
}

function resolveVehicleTier(vClass, bodyType) {
  const c = String(vClass || '').toUpperCase();
  const b = String(bodyType || '').toUpperCase();
  if (c.includes('2W') || c.includes('CYCLE') || c.includes('SCOOTER') || c.includes('M-CYCLE') || c.includes('MOTORCYCLE') || b.includes('SOLO')) return '2-Wheeler';
  if (c.includes('3W') || c.includes('THREE') || c.includes('AUTO') || c.includes('RICKSHAW')) return '3-Wheeler';
  return '4-Wheeler+';
}

const mockDatabase = {
  'KA40EF5093': {
    regNo: 'KA40EF5093',
    regDate: '04-02-2021',
    chassisNo: 'MD626CG5XL1N54566',
    engineNo: 'CG5NL1221331',
    maker: 'TVS MOTOR COMPANY LTD',
    model: 'PEARL BLUE',
    bodyType: '2 WHEELER',
    wheelBase: '1275',
    mfgDate: '11/2020',
    fuel: 'PETROL',
    validUpto: '03-02-2036',
    taxUpto: 'LTT',
    owner: 'SHARADHAM SRINIVASULU',
    swd: 'NARASIMHULU',
    address: '#1 KOLAR ROAD, VIJAYAPURA, Bangalore Rural, KA - 562135',
    ownerSerial: '01',
    color: 'PEARL BLUE',
    vehicleClassFull: 'M-Cycel/Scooter (2WN)',
    cylinders: '1',
    unladenWt: '109',
    ladenWt: '239',
    horsePower: '7.37',
    seating: '2',
    stdgSlpr: '0 / 0',
    cubicCap: '109.7',
    rto: 'CHICKABALLAPURA RTO',
    emissionNorms: 'BHARAT STAGE VI',
    financer: ''
  },
  'KA0320180012734': {
    dlNo: 'KA03 20180012734',
    doi: '06-06-2018',
    validUptoNT: '05-06-2038',
    validUptoTR: '',
    name: 'BASILEIA PAROUSIA M F',
    dob: '31-05-1999',
    bloodGroup: '',
    organDonor: 'N',
    swd: 'A M FRANCIS',
    address: 'NO 2/2 1ST CROSS NEAR ASHA NURSING HOME VANNARPET VIVEKNAGAR BANGALORE NORTH,BANGALORE,KA, 560047',
    firstIssueDate: '06-06-2018',
    adpVehNo: '',
    hazardousValidity: '',
    hillValidity: '',
    profileImage: '',
    covList: [
      { covType: 'BIKE', code: 'MCWG', issuedBy: 'KA03', doi: '06-06-2018', category: 'NT' },
      { covType: 'CAR', code: 'LMV', issuedBy: 'KA03', doi: '06-06-2018', category: 'NT' }
    ],
    mobileNo: '',
    rtoAuthority: 'RTO BANGALORE (EAST), KASTURINAGAR'
  }
};

function formatDateDisplay(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (s === '1800-01-01' || s === '01-01-1800') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const parts = s.split('-');
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return s;
}

function normalizeDob(dobStr) {
  if (!dobStr) return '';
  const str = String(dobStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  return str;
}

function enrichAddress(rawAddress, rtoAuthority, regNo) {
  let addrStr = String(rawAddress || '').trim();
  addrStr = addrStr.replace(/^[\s,./-]+/, '').trim();

  const pinMatch = addrStr.match(/\b\d{6}\b/);
  const pin = pinMatch ? pinMatch[0] : '';

  const cleanChars = addrStr.replace(/[^A-Za-z0-9]/g, '');
  const isOnlyPin = cleanChars === pin;
  const isNearRtoArtifact = /NEAR\s+RTO/i.test(addrStr);
  const lacksStreetDetails = !/(road|street|nagar|cross|layout|lane|colony|bldg|apart|flat|house|door|plot|sector|phase|bazaar|post|taluk|halli|pura|beedi|qtrs|opp|behind)/i.test(addrStr);

  if (!isNearRtoArtifact && !isOnlyPin && !lacksStreetDetails && addrStr.length > 25) {
    return addrStr;
  }

  const cleanRto = String(rtoAuthority || 'TRANSPORT OFFICE').replace(/\s*RTO/i, '').trim();
  const stateCode = String(regNo || 'KA').substring(0, 2).toUpperCase();
  const stateName = STATE_NAMES[stateCode] || 'KARNATAKA';

  const seed = String(regNo || 'V01').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const doorNo = (seed % 88) + 1;

  if (pin) {
    try {
      const records = pincodeLookup.lookup(pin);
      if (records && records.length > 0) {
        const rec = records[seed % records.length] || records[0];
        const office = String(rec.officeName || '')
          .replace(/\s*(B\.O|S\.O|H\.O)\b/i, '')
          .trim()
          .toUpperCase();
        const isRural = /B\.O\b/i.test(rec.officeName || '');
        const district = String(rec.districtName || cleanRto).trim().toUpperCase();
        const resolvedState = String(rec.stateName || stateName).trim().toUpperCase();
        const shortState = Object.keys(STATE_NAMES).find(key => STATE_NAMES[key] === resolvedState) || stateCode;

        let streetPrefix;
        if (isRural) {
          const ruralPatterns = [
            `POST OFFICE ROAD, ${office}`,
            `VILLAGE & POST ${office}`,
            `MAIN ROAD, ${office}`,
            `NEAR BUS STAND, ${office}`,
            `TEMPLE STREET, ${office}`,
            `MARKET ROAD, ${office}`,
            `PANCHAYAT ROAD, ${office}`
          ];
          streetPrefix = ruralPatterns[seed % ruralPatterns.length];
        } else {
          const urbanPatterns = [
            `#${doorNo}, 1ST CROSS, ${office}`,
            `#${doorNo}, 2ND MAIN ROAD, ${office}`,
            `#${doorNo}, BAZAAR STREET, ${office}`,
            `#${doorNo}, STATION ROAD, ${office}`,
            `#${doorNo}, GANDHI NAGAR, ${office}`,
            `#${doorNo}, MARKET ROAD, ${office}`,
            `#${doorNo}, 3RD BLOCK, ${office}`,
            `#${doorNo}, TEMPLE STREET, ${office}`,
            `#${doorNo}, 4TH CROSS, ${office}`,
            `#${doorNo}, NEHRU STREET, ${office}`
          ];
          streetPrefix = urbanPatterns[seed % urbanPatterns.length];
        }

        return `${streetPrefix}, ${district}, ${shortState} - ${pin}`;
      }
    } catch (err) {
      console.warn('[Pincode Lookup Exception]:', err.message);
    }
  }

  return `#${doorNo}, MAIN ROAD, ${cleanRto.toUpperCase()}, ${stateCode} - ${pin || '560001'}`;
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function verifyPassword(password, storedPassword) {
  if (!storedPassword) return { valid: false, legacy: false };
  const stored = String(storedPassword);
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return { valid: false, legacy: false };
    const salt = parts[1];
    const storedHash = parts[2];
    try {
      const derivedKey = await scryptAsync(String(password), salt, 64);
      const derivedHex = Buffer.from(derivedKey).toString('hex');
      return { valid: safeEqual(derivedHex, storedHash), legacy: false };
    } catch {
      return { valid: false, legacy: false };
    }
  }
  return { valid: safeEqual(String(password), stored), legacy: true };
}

async function findCustomerByToken(token) {
  if (!token) return null;
  
  for (const customer of customers.values()) {
    if (!customer || !customer.sessionToken) continue;
    if (safeEqual(customer.sessionToken, token)) {
      if (customer.expiresAt && Date.now() > customer.expiresAt) {
        customers.delete(customer.customerId);
        return null;
      }
      return customer;
    }
  }

  try {
    const res = await pool.query(
      'SELECT token, mobile, expires_at FROM customer_sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1',
      [token]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      const customerId = 'CUST_' + row.mobile;
      const restored = {
        customerId,
        mobile: row.mobile,
        sessionToken: row.token,
        verifiedAt: new Date(),
        expiresAt: new Date(row.expires_at).getTime()
      };
      customers.set(customerId, restored);
      return restored;
    }
  } catch (err) {}

  return null;
}

async function resolveAuthContext(authHeader) {
  const header = String(authHeader || '');
  if (!header.startsWith('Bearer ')) {
    return { role: 'PUBLIC', agentId: null, customerId: null, mobile: null };
  }
  const token = header.slice(7).trim();
  if (!token) {
    return { role: 'PUBLIC', agentId: null, customerId: null, mobile: null };
  }

  if (ADMIN_SESSION_TOKEN && safeEqual(token, ADMIN_SESSION_TOKEN)) {
    return { role: 'ADMIN', agentId: null, customerId: null, mobile: null };
  }

  if (token.startsWith('TOK_AGT_')) {
    try {
      const agt = await pool.query('SELECT * FROM agents WHERE session_token = $1 AND status = $2', [token, 'ACTIVE']);
      if (agt.rows.length > 0) {
        const agent = agt.rows[0];
        return { role: 'AGENT', agentId: agent.agent_id, customerId: null, mobile: agent.mobile || null, agent };
      }
    } catch (err) {
      console.error('[Agent Auth DB Error]:', err.message);
    }
  }

  if (token.startsWith('TOK_CUST_')) {
    const customer = await findCustomerByToken(token);
    if (customer) {
      return { role: 'CUSTOMER', agentId: null, customerId: customer.customerId, mobile: customer.mobile || null, customer };
    }
    return { role: 'CUSTOMER', agentId: null, customerId: null, mobile: null, customer: null };
  }

  return { role: 'PUBLIC', agentId: null, customerId: null, mobile: null };
}

const ordersSecuritySchemaReady = (async () => {
  try {
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS owner_id TEXT,
        ADD COLUMN IF NOT EXISTS owner_role TEXT,
        ADD COLUMN IF NOT EXISTS rzp_order_id TEXT,
        ADD COLUMN IF NOT EXISTS dob TEXT,
        ADD COLUMN IF NOT EXISTS rc_format TEXT;

      CREATE TABLE IF NOT EXISTS customer_sessions (
        token TEXT PRIMARY KEY,
        mobile TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.error('[Security] Schema init warning:', err.message);
  }
})();

async function generateSignaturePng(fullName) {
  const seedStr = String(fullName || 'Driver');
  const seed = seedStr.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const style = seed % 4;

  let pathData = '';
  if (style === 0) {
    pathData = `M 22 28 C 25 15, 35 8, 42 18 C 50 28, 42 35, 52 24 C 60 16, 70 18, 78 22 C 86 26, 95 15, 105 22 C 115 29, 122 18, 132 20 C 142 22, 150 16, 165 22 M 26 31 C 70 35, 120 32, 172 28`;
  } else if (style === 1) {
    pathData = `M 20 25 C 28 8, 38 32, 45 15 C 52 2, 60 22, 70 20 C 85 18, 95 28, 110 21 C 125 14, 140 24, 168 21 M 25 33 C 75 36, 125 33, 170 30`;
  } else if (style === 2) {
    pathData = `M 22 22 L 35 12 L 48 26 L 62 15 L 75 28 L 92 18 C 110 15, 125 25, 145 20 C 155 18, 162 22, 172 21 M 24 32 C 70 35, 120 33, 170 29`;
  } else {
    pathData = `M 24 26 C 30 18, 38 15, 45 22 C 52 29, 60 18, 70 21 C 82 24, 92 17, 105 22 C 120 27, 135 19, 168 21 M 28 33 C 70 35, 120 32, 172 30`;
  }

  const svg = `<svg width="220" height="45" viewBox="0 0 220 45" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-2 110 22)"><path d="${pathData}" fill="none" stroke="#050c1a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;

  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    return null;
  }
}

async function getVehicleOrDlRecord(docType, rawTargetNumber, dob) {
  const lookupKey = String(rawTargetNumber || '').replace(/[^A-Z0-9]/g, '').toUpperCase();

  if (mockDatabase[lookupKey]) {
    return mockDatabase[lookupKey];
  }

  try {
    const dbRes = await pool.query(
      'SELECT raw_data FROM documents_cache WHERE doc_type = $1 AND lookup_key = $2',
      [docType, lookupKey]
    );
    if (dbRes.rows && dbRes.rows.length > 0) {
      const cached = dbRes.rows[0].raw_data;
      if (cached && cached.address) {
        cached.address = enrichAddress(cached.address, cached.rto || cached.rtoAuthority, lookupKey);
      }
      return cached;
    }
  } catch (dbErr) {}

  if (!SUREPASS_BEARER_TOKEN) {
    return null;
  }

  try {
   if (docType === 'RC') {
      let resp = await fetchWithTimeout(`${SUREPASS_BASE_URL}/api/v1/rc/rc-full`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
        },
        body: JSON.stringify({ id_number: lookupKey }),
        timeout: 12000
      });

      let json = await resp.json();

      if (!resp.ok || !json.success || !json.data) {
        return null;
      }

      const d = json.data;
      let normalizedBody = String(d.body_type || 'SEDAN').trim();
      if (/SOLO/i.test(normalizedBody)) normalizedBody = 'SOLO';

      let normalizedColor = String(d.color || '').trim()
        .replace(/ELECTRONIC\s+ORANGE/i, 'E. ORANGE')
        .replace(/METALLIC\s+/i, 'MET. ')
        .replace(/ELECTRONIC\s+/i, 'E. ');

      let rawSurepassAddr = String(d.present_address || d.permanent_address || '').trim();
      rawSurepassAddr = rawSurepassAddr.replace(/^[\s,./-]+/, '').trim();

      if (!rawSurepassAddr || /^\d{6}$/.test(rawSurepassAddr)) {
        const split = d.split_address || {};
        const parts = [
          split.address_line,
          split.city || split.district,
          split.state,
          split.pincode
        ].filter(Boolean);
        rawSurepassAddr = parts.join(', ').trim();
      }

      const formattedRc = {
        regNo: d.rc_number || lookupKey,
        regDate: formatDateDisplay(d.registration_date || ''),
        chassisNo: d.vehicle_chasi_number || '',
        engineNo: d.vehicle_engine_number || '',
        maker: d.maker_description || d.maker_model || '',
        model: d.maker_model || '',
        bodyType: normalizedBody,
        wheelBase: String(d.wheelbase || '0'),
        mfgDate: d.manufacturing_date || '',
        fuel: String(d.fuel_type || 'PETROL').toUpperCase(),
        validUpto: formatDateDisplay(d.fit_up_to || ''),
        taxUpto: d.tax_upto || 'LTT',
        owner: d.owner_name || '',
        swd: d.father_name || 'NA',
        address: enrichAddress(rawSurepassAddr, d.registered_at, lookupKey),
        ownerSerial: String(d.owner_number || '01').padStart(2, '0'),
        color: normalizedColor,
        vehicleClassFull: d.vehicle_category_description || d.vehicle_category || 'Motor Car (LMV)',
        cylinders: String(d.no_cylinders || '4'),
        unladenWt: String(d.unladen_weight || '0'),
        ladenWt: String(d.vehicle_gross_weight || '0'),
        horsePower: String(d.horse_power || '0'),
        seating: String(d.seat_capacity || '5'),
        stdgSlpr: `${d.standing_capacity || 0} / ${d.sleeper_capacity || 0}`,
        cubicCap: String(d.cubic_capacity || '0'),
        rto: d.registered_at || 'TRANSPORT DEPARTMENT',
        emissionNorms: d.norms_type || 'BHARAT STAGE VI',
        financer: d.financer || ''
      };

      pool.query(
        `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (lookup_key)
         DO UPDATE SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
        [docType, lookupKey, JSON.stringify(formattedRc)]
      ).catch(() => {});

      mockDatabase[lookupKey] = formattedRc;
      return formattedRc;

    } else if (docType === 'DL') {
      const cleanDob = normalizeDob(dob);

      let resp;
      let json;

      try {
        resp = await fetchWithTimeout(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
          },
          body: JSON.stringify({ id_number: lookupKey, dob: cleanDob }),
          timeout: 12000
        });
        json = await resp.json();
      } catch (fetchErr) {
        return null;
      }

      if (json && json.status_code === 500 && json.message && json.message.includes('Timed Out')) {
        await new Promise(res => setTimeout(res, 1200));
        try {
          resp = await fetchWithTimeout(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
            },
            body: JSON.stringify({ id_number: lookupKey, dob: cleanDob }),
            timeout: 12000
          });
          json = await resp.json();
        } catch (retryErr) {
          return null;
        }
      }

      if (!resp || !resp.ok || !json || !json.success || !json.data) {
        return null;
      }

      const d = json.data;

      let parsedCovList = [];
      const rawCov = d.vehicle_classes || d.cov_details || [];

      const issueDateClean = formatDateDisplay(d.doi || d.issue_date || d.initial_doi);
      const issuingOfficeCode = d.ola_code || (lookupKey.length >= 4 ? lookupKey.substring(0, 4) : 'RTO');

      if (Array.isArray(rawCov)) {
        parsedCovList = rawCov.map(item => {
          let codeName = '';
          if (typeof item === 'string') {
            codeName = item;
          } else if (typeof item === 'object' && item !== null) {
            codeName = item.class_of_vehicle || item.code || item.cov || 'LMV';
          }
          const str = String(codeName || '').trim().toUpperCase();

          let assignedType = 'BIKE';
          if (str.includes('LMV') || str.includes('CAR') || str.includes('MOTOR CAR')) {
            assignedType = 'CAR';
          } else if (str.includes('3W') || str.includes('3 W') || str.includes('AUTO') || str.includes('RICKSHAW') || str.includes('CAB')) {
            assignedType = 'THREE_WHEELER';
          }

          return {
            covType: assignedType,
            code: str || 'MCWG',
            issuedBy: issuingOfficeCode,
            doi: issueDateClean,
            category: d.transport_doe && d.transport_doe !== '1800-01-01' ? 'TR' : 'NT',
            badgeNo: '',
            badgeDoi: '',
            badgeBy: ''
          };
        });
      }

      const fullAddress = [
        d.permanent_address || d.temporary_address || (typeof d.address === 'string' ? d.address : ''),
        d.permanent_zip || ''
      ].filter(Boolean).join(', ');

      const validPhoto = (d.has_image && typeof d.profile_image === 'string' && d.profile_image.length > 200)
        ? d.profile_image
        : '';

      const formattedDl = {
        dlNo: d.license_number || lookupKey,
        doi: issueDateClean,
        validUptoNT: formatDateDisplay(d.doe || d.nt_validity_to || (d.validity && d.validity.non_transport)),
        validUptoTR: d.transport_doe && d.transport_doe !== '1800-01-01' ? formatDateDisplay(d.transport_doe) : '',
        name: String(d.name || '').replace(/[\r\n]+/g, ' ').trim(),
        dob: formatDateDisplay(d.dob || cleanDob),
        bloodGroup: String(d.blood_group || '').trim(),
        organDonor: 'N',
        swd: String(d.father_or_husband_name || 'NA').replace(/[\r\n]+/g, ' ').trim(),
        address: enrichAddress(fullAddress, d.ola_name || d.issuing_authority, lookupKey),
        firstIssueDate: formatDateDisplay(d.initial_doi || d.doi || '10-06-2011'),
        profileImage: validPhoto,
        adpVehNo: '',
        hazardousValidity: '',
        hillValidity: '',
        covList: parsedCovList,
        mobileNo: '',
        rtoAuthority: String(d.ola_name || d.issuing_authority || 'RTO OFFICE').trim()
      };

      pool.query(
        `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (lookup_key)
         DO UPDATE SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
        [docType, lookupKey, JSON.stringify(formattedDl)]
      ).catch(() => {});

      mockDatabase[lookupKey] = formattedDl;
      return formattedDl;
    }
  } catch (err) {
    return null;
  }

  return null;
}

const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

const fieldLayout = {
  header: {
    regNoY: 140.5,
    regNoFontSize: 9.5,
    form: { label: 'FORM-23A', rightAnchorX: 236.0, y: 141.0, fontSize: 6.5 },
    formNote: { label: '(See Rule 48)', rightAnchorX: 236.0, y: 135.0, fontSize: 5.5 }
  },
  topLeft: [
    { label: 'REG.DATE', labelX: 6, dotX: 42, colonX: 57, valueX: 62, y: 126, fontSize: 6.8, isDot: true },
    { label: 'CHASSIS NO.', labelX: 6, dotX: 46, colonX: 57, valueX: 62, y: 119, fontSize: 6.8, isDot: true },
    { label: 'ENGINE NO', labelX: 6, dotX: 44, colonX: 57, valueX: 62, y: 112, fontSize: 6.8, isDot: true },
    { label: 'MFR', labelX: 6, colonX: 57, valueX: 62, y: 105, fontSize: 6.8, isDot: false, maxW: 175 }
  ],
  topRight: [
    { label: 'O SLNO', labelX: 148, colonX: 176, valueX: 181, y: 126, fontSize: 6.8, maxW: 44 },
    { label: 'CLASS', labelX: 148, colonX: 176, valueX: 181, y: 119, fontSize: 6.8, maxW: 65 },
    { label: 'COLOUR', labelX: 148, colonX: 176, valueX: 181, y: 112, fontSize: 6.8, maxW: 56 }
  ],
  middle: [
    { label: 'OWNERNAME', labelX: 6, colonX: 57, valueX: 62, y: 93, fontSize: 6.8, maxW: 175 },
    { label: 'S/W/D OF', labelX: 6, colonX: 57, valueX: 62, y: 86, fontSize: 6.8, maxW: 175 },
    { label: 'ADDRESS', labelX: 6, colonX: 57, valueX: 62, y: 79, fontSize: 6.8, multiLine: true, maxLines: 3, lineHeight: 5.8, maxW: 175 }
  ],
  bottomLeft: [
    { label: 'MODEL', labelX: 6, colonX: 57, valueX: 62, y: 56, fontSize: 6.8, maxW: 120 },
    { label: 'BODY', labelX: 6, colonX: 57, valueX: 62, y: 49, fontSize: 6.8, maxW: 36 },
    { label: 'WHEEL BASE', labelX: 6, colonX: 57, valueX: 62, y: 42, fontSize: 6.8, maxW: 36 },
    { label: 'MFG DATE', labelX: 6, colonX: 57, valueX: 62, y: 35, fontSize: 6.8, maxW: 36 },
    { label: 'FUEL', labelX: 6, colonX: 57, valueX: 62, y: 28, fontSize: 6.8, maxW: 36 },
    { label: 'REG/FC UPTO', labelX: 6, colonX: 57, valueX: 62, y: 21, fontSize: 6.8, maxW: 36 },
    { label: 'TAX UPTO', labelX: 6, colonX: 57, valueX: 62, y: 14, fontSize: 6.8, maxW: 36 }
  ],
  bottomRight: [
    { label: 'NO.OF CYL', labelX: 98, dotX: 132, colonX: 146, valueX: 151, y: 49, fontSize: 6.8, isDot: true, maxW: 48 },
    { label: 'UNLADEN WT', labelX: 98, colonX: 146, valueX: 151, y: 42, fontSize: 6.8, maxW: 48 },
    { label: 'SEATING', labelX: 98, colonX: 146, valueX: 151, y: 35, fontSize: 6.8, maxW: 48 },
    { label: 'STDG/SLPR', labelX: 98, colonX: 146, valueX: 151, y: 28, fontSize: 6.8, maxW: 48 },
    { label: 'CC', labelX: 98, colonX: 146, valueX: 151, y: 21, fontSize: 6.8, maxW: 48 }
  ],
  footer: {
    authority: { label: 'Registering Authority', rightAnchorX: 236.0, y: 11.5, fontSize: 6.5 },
    rto: { rightAnchorX: 236.0, y: 4.0, fontSize: 6.8 }
  }
};

const newRcFrontLayout = {
  regNo: { x: 56.0, yTop: 41.0, size: 6.5, font: 'bold', maxW: 65 },
  regDate: { x: 126.0, yTop: 41.0, size: 6.5, font: 'bold', maxW: 55 },
  validUpto: { x: 186.0, yTop: 41.0, size: 6.5, font: 'bold', maxW: 55 },
  chassisNo: { x: 56.7, yTop: 58.5, size: 6.5, font: 'regular', maxW: 140 },
  ownerSerial: { x: 212.0, yTop: 56.0, size: 6.8, font: 'bold', maxW: 15 },
  engineNo: { x: 56.7, yTop: 80.0, size: 6.5, font: 'regular', maxW: 140 },
  ownerName: { x: 56.7, yTop: 96.0, size: 6.5, font: 'regular', maxW: 140 },
  swdName: { x: 56.7, yTop: 114.5, size: 6.5, font: 'regular', maxW: 140 },
  fuel: { x: 2.5, yTop: 115.5, size: 6.5, font: 'regular', maxW: 55 },
  emissionNorms: { x: 1.0, yTop: 135.5, size: 5.5, font: 'regular', maxW: 52 },
  address: { x: 56.7, line2X: 56.7, yTop: 132.5, size: 5.8, font: 'regular', multiLine: true, maxLines: 3, lineHeight: 5.8, maxW: 180 }
};

const newRcBackLayout = {
  vehicleClass: { x: 101.0, yTop: 13.5, size: 6.0, font: 'regular', maxW: 120 },
  regNo: { x: 10.0, yTop: 32.5, size: 6.0, font: 'regular', maxW: 40 },
  maker: { x: 58.0, yTop: 32.5, size: 6.0, font: 'regular', maxW: 175 },
  model: { x: 58.0, yTop: 49.0, size: 6.0, font: 'regular', maxW: 175 },
  bodyType: { x: 58.0, yTop: 66.0, size: 6.0, font: 'regular', maxW: 175 },
  seatingCapacity: { x: 60.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  standingCapacity: { x: 104.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  sleeperCapacity: { x: 138.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  mfgDate: { x: 10.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 35 },
  unladenWeight: { x: 64.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  ladenWeight: { x: 94.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  grossWeight: { x: 126.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  cylinders: { x: 18.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  cubicCapacity: { x: 64.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  horsePower: { x: 104.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  wheelbase: { x: 166.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 35 },
  financer: { x: 58.0, yTop: 135.5, size: 5.5, font: 'regular', maxW: 110 },
  rtoAuthority: { x: 236.0, yTop: 149.5, size: 5.5, font: 'regular', maxW: 100, rightAnchor: true }
};

const oldDlBackLayout = {
  dlNo: { x: 92.0, yTop: 28.5, size: 6.8, font: 'bold', maxW: 130 },
  doi: { x: 198.0, yTop: 28.5, size: 6.5, font: 'bold', maxW: 65 },
  name: { x: 92.0, yTop: 36.5, size: 6.5, font: 'bold', maxW: 140 },
  dob: { x: 92.0, yTop: 44.5, size: 6.5, font: 'bold', maxW: 120 },
  validUptoNT: { x: 92.0, yTop: 52.5, size: 6.5, font: 'bold', maxW: 130 },
  swd: { x: 92.0, yTop: 102.0, size: 6.5, font: 'bold', maxW: 140 },
  address: { x: 92.0, yTop: 114.0, size: 5.5, font: 'bold', multiLine: true, maxLines: 3, lineHeight: 5.2, maxW: 150 },
  rtoAuthority: { x: 236.0, yTop: 143.0, size: 5.5, font: 'bold', maxW: 100, rightAnchor: true }
};

function getTemplatePath(candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(__dirname, 'public', 'assets', 'templates', candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function isCommercialClass(vClass) {
  if (!vClass) return false;
  const str = String(vClass).toUpperCase();
  return (
    str.includes('CAB') || str.includes('TAXI') || str.includes('GOODS') ||
    str.includes('BUS') || str.includes('MAXI') || str.includes('COMMERCIAL') ||
    str.includes('CARRIAGE') || str.includes('STAGE')
  );
}

app.post('/api/customer/send-otp', otpLimiter, async (req, res) => {
  const { mobile } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');

  if (cleanMobile.length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  try {
    if (!MSG91_AUTH_KEY || !MSG91_TOKEN_AUTH) {
      return res.status(503).json({ error: 'SMS verification service is not configured.' });
    }

    const response = await fetchWithTimeout('https://api.msg91.com/api/v5/widget/sendOtp', {
      method: 'POST',
      headers: { 'authkey': MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ widgetId: MSG91_WIDGET_ID, tokenAuth: MSG91_TOKEN_AUTH, identifier: `91${cleanMobile}` }),
      timeout: 10000
    });

    const data = await response.json();

    if (data.type === 'success' || data.message === 'OTP sent successfully' || data.reqId) {
      otpStore.set(cleanMobile, { reqId: data.reqId || data.message, attempts: 0, expiresAt: Date.now() + 10 * 60 * 1000 });
      return res.json({ success: true, message: 'Verification code sent via SMS.', mobile: cleanMobile });
    }

    return res.status(400).json({ error: data.message || 'Failed to dispatch SMS OTP.' });
  } catch (err) {
    return res.status(500).json({ error: 'SMS service temporarily unavailable.' });
  }
});

app.post('/api/customer/verify-otp', otpLimiter, async (req, res) => {
  const { mobile, otp } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');
  const enteredOtp = String(otp || '').trim();

  if (cleanMobile.length !== 10) return res.status(400).json({ error: 'Invalid mobile number.' });

  const record = otpStore.get(cleanMobile);
  if (!record || !record.reqId) return res.status(400).json({ error: 'No OTP session found for this number.' });

  if (!record.expiresAt || Date.now() > record.expiresAt) {
    otpStore.delete(cleanMobile);
    return res.status(400).json({ error: 'OTP session has expired.' });
  }

  try {
    const response = await fetchWithTimeout('https://api.msg91.com/api/v5/widget/verifyOtp', {
      method: 'POST',
      headers: { 'authkey': MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ widgetId: MSG91_WIDGET_ID, tokenAuth: MSG91_TOKEN_AUTH, reqId: record.reqId, otp: enteredOtp }),
      timeout: 10000
    });

    const data = await response.json();

    if (data.type === 'success' || data['access-token'] || data.message === 'OTP verified success') {
      otpStore.delete(cleanMobile);
      const token = 'TOK_CUST_' + crypto.randomBytes(24).toString('hex');
      const customerId = 'CUST_' + cleanMobile;
      const expiresAtDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      customers.set(customerId, { customerId, mobile: cleanMobile, sessionToken: token, verifiedAt: new Date(), expiresAt: expiresAtDate.getTime() });

      pool.query(
        `INSERT INTO customer_sessions (token, mobile, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING`,
        [token, cleanMobile, expiresAtDate]
      ).catch(() => {});

      return res.json({ success: true, token, mobile: cleanMobile, message: 'Mobile identity verified successfully.' });
    }

    return res.status(400).json({ error: data.message || 'Invalid or expired OTP code.' });
  } catch (err) {
    return res.status(500).json({ error: 'Verification service error.' });
  }
});

app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  const secretKey = String(req.body.secretKey || '').trim();
  const masterSecret = String(ADMIN_MASTER_SECRET || '').trim();

  if (masterSecret && secretKey && safeEqual(secretKey, masterSecret)) {
    return res.json({ success: true, token: ADMIN_SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid Admin Master Secret Key' });
});

app.get('/api/admin/stats', async (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const statsRes = await pool.query(`SELECT COUNT(*)::int AS total_downloads, COUNT(CASE WHEN doc_type = 'RC' THEN 1 END)::int AS rc_count, COUNT(CASE WHEN doc_type = 'DL' THEN 1 END)::int AS dl_count, COALESCE(SUM(amount), 0)::numeric AS total_revenue FROM orders WHERE status = 'SUCCESS';`);
    const agentStatsRes = await pool.query(`SELECT COUNT(*)::int AS total_agents, COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END)::int AS active_agents, COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END)::int AS pending_agents FROM agents;`);
    res.json({ success: true, summary: statsRes.rows[0], agents: agentStatsRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const result = await pool.query(`SELECT order_id, user_phone, doc_type, lookup_key, amount, status, utr, created_at, paid_at FROM orders ORDER BY created_at DESC LIMIT 100;`);
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/rc-preview', orderLimiter, async (req, res) => {
  try {
    const { regNo } = req.body;
    const authHeader = req.headers['authorization'] || '';
    const authContext = await resolveAuthContext(authHeader);

    if (authContext.role === 'PUBLIC') return res.status(401).json({ error: 'Please verify your mobile number.' });

    const report = await getVehicleOrDlRecord('RC', regNo);
    if (!report) return res.status(404).json({ error: 'Vehicle details could not be found.' });

    const detectedTier = resolveVehicleTier(report.vehicleClassFull, report.bodyType);
    let amount = detectedTier === '3-Wheeler' ? 180 : detectedTier === '4-Wheeler+' ? 200 : 150;

    return res.json({
      success: true,
      regNo: report.regNo,
      brandName: [report.maker, report.model].filter(Boolean).join(' — ') || 'AUTOMOBILE',
      ownerMasked: maskEvenly(report.owner),
      chassisMasked: maskEvenly(report.chassisNo),
      engineMasked: maskEvenly(report.engineNo),
      detectedTier,
      amount,
      isKA: (report.regNo || '').substring(0, 2).toUpperCase() === 'KA'
    });
  } catch (err) {
    res.status(500).json({ error: 'Preview error' });
  }
});

app.post('/api/create-order', orderLimiter, async (req, res) => {
  try {
    await ordersSecuritySchemaReady;
    const { docType, targetNumber, tier, dob, rcFormat, customerMobile } = req.body;
    const localOrderId = 'ORD_' + Date.now();
    const finalAmount = docType === 'DL' ? 150 : 150;

    let rzpOrderId = null;
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      const rzpOrder = await razorpay.orders.create({ amount: Math.round(finalAmount * 100), currency: 'INR', receipt: localOrderId });
      rzpOrderId = rzpOrder.id;
    }

    const effectiveOrderId = rzpOrderId || localOrderId;
    orders.set(effectiveOrderId, { orderId: effectiveOrderId, docType, targetNumber, amount: finalAmount, dob, rcFormat: rcFormat || 'OLD', status: 'SUCCESS' });

    res.json({ success: true, orderId: effectiveOrderId, amount: finalAmount, amountPaise: Math.round(finalAmount * 100), keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ error: 'Order creation failed' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = orders.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
    res.json({ status: 'SUCCESS', orderId: order.orderId, docType: order.docType, rcFormat: order.rcFormat || 'OLD', report });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

async function generateVectorPdfBuffer(docType, rcFormat, report) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const cardW = 260.0;
  const S = cardW / CARD_WIDTH;
  const cardH = CARD_HEIGHT * S;
  const gap = 14.0;

  const totalW = (cardW * 2) + gap;
  const startX = (width - totalW) / 2;
  const topMargin = 72.0;
  const startY = height - topMargin - cardH;

  const leftCardX = startX;
  const rightCardX = startX + cardW + gap;
  const cardY = startY;
  const solidBlack = rgb(0, 0, 0);

  function splitAddress(addr, maxChars = 38) {
    if (!addr) return [''];
    const clean = String(addr).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxChars) return [clean];
    const words = clean.split(' ');
    const lines = [];
    let currentLine = '';
    for (let word of words) {
      if (!currentLine) currentLine = word;
      else if ((currentLine + ' ' + word).length <= maxChars) currentLine += ' ' + word;
      else { lines.push(currentLine); currentLine = word; }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  function getFittedSize(text, targetFont, initialSize, minSize, maxWidth) {
    let size = initialSize;
    const str = String(text || '').trim();
    for (let i = 0; i < 12; i++) {
      if (size <= minSize || targetFont.widthOfTextAtSize(str, size) <= maxWidth) break;
      size -= 0.25;
    }
    return Math.max(size, minSize);
  }

  const roundedMask = Buffer.from(`<svg width="1040" height="655"><rect x="0" y="0" width="1040" height="655" rx="32" ry="32" fill="#fff"/></svg>`);

  if (docType === 'DL' && rcFormat === 'OLD') {
    const frontPath = getTemplatePath(['old_dl_front.png', 'dl_front.png']);
    if (frontPath) {
      const maskedFrontPng = await sharp(frontPath).resize(1040, 655).composite([{ input: roundedMask, blend: 'dest-in' }]).png().toBuffer();
      page.drawImage(await pdfDoc.embedPng(maskedFrontPng), { x: leftCardX, y: cardY, width: cardW, height: cardH });
    }

    const backPath = getTemplatePath(['old_dl_back.png', 'dl_back.png']);
    if (backPath) {
      const maskedBackPng = await sharp(backPath).resize(1040, 655).composite([{ input: roundedMask, blend: 'dest-in' }]).png().toBuffer();
      page.drawImage(await pdfDoc.embedPng(maskedBackPng), { x: rightCardX, y: cardY, width: cardW, height: cardH });
    }

    if (report.profileImage && typeof report.profileImage === 'string' && report.profileImage.length > 200) {
      try {
        const cleanBase64 = report.profileImage.replace(/^data:image\/\w+;base64,/, '').trim();
        const rawPhotoBuffer = Buffer.from(cleanBase64, 'base64');
        if (rawPhotoBuffer.length > 200) {
          const photoPng = await sharp(rawPhotoBuffer, { failOnError: false }).resize(150, 180, { fit: 'cover' }).png().toBuffer();
          const embeddedPhoto = await pdfDoc.embedPng(photoPng);
          page.drawImage(embeddedPhoto, {
            x: rightCardX + (36.0 * S),
            y: cardY + ((CARD_HEIGHT - 110.0) * S),
            width: 32.5 * S,
            height: 38.0 * S
          });
        }
      } catch (err) {}
    }

    const backData = {
      dlNo: report.dlNo || '',
      doi: report.doi || '',
      name: report.name || '',
      dob: report.dob || '',
      validUptoNT: `${report.validUptoNT || ''} ${report.validUptoTR ? '(TR)' : '(NT)'}`.trim(),
      swd: report.swd || 'NA',
      address: report.address || ''
    };

    Object.entries(oldDlBackLayout).forEach(([key, cfg]) => {
      const val = backData[key] || '';
      if (!val) return;
      const baselineY = CARD_HEIGHT - cfg.yTop;

      if (cfg.multiLine) {
        const lines = splitAddress(val, 38);
        lines.slice(0, cfg.maxLines).forEach((line, idx) => {
          page.drawText(String(line).trim(), {
            x: rightCardX + (cfg.x * S),
            y: cardY + ((baselineY - (idx * cfg.lineHeight)) * S),
            size: cfg.size * S,
            font: fontBold,
            color: solidBlack
          });
        });
      } else {
        const textVal = String(val).trim();
        const fontSize = getFittedSize(textVal, fontBold, cfg.size * S, 3.8 * S, (cfg.maxW || 100) * S);
        page.drawText(textVal, {
          x: rightCardX + (cfg.x * S),
          y: cardY + (baselineY * S),
          size: fontSize,
          font: fontBold,
          color: solidBlack
        });
      }
    });

    if (report.covList && Array.isArray(report.covList)) {
      for (let idx = 0; idx < Math.min(report.covList.length, 5); idx++) {
        const cov = report.covList[idx];
        const rowPitch = 10.5;
        const rowY = 70.0 + (idx * rowPitch);

        const codeVal = String(cov.code || '').trim();
        page.drawText(codeVal, { x: rightCardX + (62.0 * S), y: cardY + ((CARD_HEIGHT - rowY) * S), size: 6.0 * S, font: fontBold, color: solidBlack });
        const issuedVal = String(cov.issuedBy || '').trim();
        page.drawText(issuedVal, { x: rightCardX + (95.0 * S), y: cardY + ((CARD_HEIGHT - rowY) * S), size: 6.0 * S, font: fontBold, color: solidBlack });
        const doiVal = String(cov.doi || '').trim();
        page.drawText(doiVal, { x: rightCardX + (128.0 * S), y: cardY + ((CARD_HEIGHT - rowY) * S), size: 6.0 * S, font: fontBold, color: solidBlack });
        const catVal = String(cov.category || 'NT').trim();
        page.drawText(catVal, { x: rightCardX + (178.0 * S), y: cardY + ((CARD_HEIGHT - rowY) * S), size: 6.0 * S, font: fontBold, color: solidBlack });
      }
    }

    const rtoVal = String(report.rtoAuthority || 'RTO OFFICE').trim();
    const rtoWidth = fontBold.widthOfTextAtSize(rtoVal, 5.5 * S);
    page.drawText(rtoVal, {
      x: rightCardX + ((236.0 * S) - rtoWidth),
      y: cardY + ((CARD_HEIGHT - 143.0) * S),
      size: 5.5 * S,
      font: fontBold,
      color: solidBlack
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = orders.get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
    const pdfBuffer = await generateVectorPdfBuffer(order.docType, order.rcFormat || 'OLD', report);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="DL_${report.dlNo || 'Document'}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

app.get('/api/user/history', async (req, res) => {
  res.json({ success: true, history: [] });
});

app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Backend Running at: http://localhost:${PORT}`);
});