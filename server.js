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

// Restored Root Route to serve the frontend properly
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
  if (addrStr.length > 25) return addrStr;
  const cleanRto = String(rtoAuthority || 'TRANSPORT OFFICE').replace(/\s*RTO/i, '').trim();
  const stateCode = String(regNo || 'KA').substring(0, 2).toUpperCase();
  return `#1, MAIN ROAD, ${cleanRto.toUpperCase()}, ${stateCode} - ${pin || '560001'}`;
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
    const res = await pool.query('SELECT token, mobile, expires_at FROM customer_sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1', [token]);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      const customerId = 'CUST_' + row.mobile;
      const restored = { customerId, mobile: row.mobile, sessionToken: row.token, verifiedAt: new Date(), expiresAt: new Date(row.expires_at).getTime() };
      customers.set(customerId, restored);
      return restored;
    }
  } catch (err) {}
  return null;
}

async function resolveAuthContext(authHeader) {
  const header = String(authHeader || '');
  if (!header.startsWith('Bearer ')) return { role: 'PUBLIC', agentId: null, customerId: null, mobile: null };
  const token = header.slice(7).trim();
  if (!token) return { role: 'PUBLIC', agentId: null, customerId: null, mobile: null };

  if (ADMIN_SESSION_TOKEN && safeEqual(token, ADMIN_SESSION_TOKEN)) return { role: 'ADMIN', agentId: null, customerId: null, mobile: null };

  if (token.startsWith('TOK_AGT_')) {
    try {
      const agt = await pool.query('SELECT * FROM agents WHERE session_token = $1 AND status = $2', [token, 'ACTIVE']);
      if (agt.rows.length > 0) {
        const agent = agt.rows[0];
        return { role: 'AGENT', agentId: agent.agent_id, customerId: null, mobile: agent.mobile || null, agent };
      }
    } catch (err) {}
  }

  if (token.startsWith('TOK_CUST_')) {
    const customer = await findCustomerByToken(token);
    if (customer) return { role: 'CUSTOMER', agentId: null, customerId: customer.customerId, mobile: customer.mobile || null, customer };
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
  } catch (err) {}
})();

async function generateSignaturePng(fullName) {
  const seedStr = String(fullName || 'Driver');
  const seed = seedStr.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const pathData = `M 22 28 C 25 15, 35 8, 42 18 C 50 28, 42 35, 52 24 C 60 16, 70 18, 78 22 C 86 26, 95 15, 105 22 C 115 29, 122 18, 132 20 C 142 22, 150 16, 165 22 M 26 31 C 70 35, 120 32, 172 28`;
  const svg = `<svg width="220" height="45" viewBox="0 0 220 45" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-2 110 22)"><path d="${pathData}" fill="none" stroke="#050c1a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    return null;
  }
}

async function getVehicleOrDlRecord(docType, rawTargetNumber, dob) {
  const lookupKey = String(rawTargetNumber || '').replace(/[^A-Z0-9]/g, '').toUpperCase();
  if (mockDatabase[lookupKey]) return mockDatabase[lookupKey];

  try {
    const dbRes = await pool.query('SELECT raw_data FROM documents_cache WHERE doc_type = $1 AND lookup_key = $2', [docType, lookupKey]);
    if (dbRes.rows && dbRes.rows.length > 0) {
      const cached = dbRes.rows[0].raw_data;
      if (cached && cached.address) cached.address = enrichAddress(cached.address, cached.rto || cached.rtoAuthority, lookupKey);
      return cached;
    }
  } catch (dbErr) {}

  if (!SUREPASS_BEARER_TOKEN) return null;

  try {
    if (docType === 'DL') {
      const cleanDob = normalizeDob(dob);
      let resp = await fetchWithTimeout(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}` },
        body: JSON.stringify({ id_number: lookupKey, dob: cleanDob }),
        timeout: 12000
      });
      let json = await resp.json();
      if (!resp.ok || !json.success || !json.data) return null;

      const d = json.data;
      const rawCov = d.vehicle_classes || d.cov_details || [];
      const issueDateClean = formatDateDisplay(d.doi || d.issue_date || d.initial_doi);
      const issuingOfficeCode = d.ola_code || (lookupKey.length >= 4 ? lookupKey.substring(0, 4) : 'RTO');

      let parsedCovList = [];
      if (Array.isArray(rawCov)) {
        parsedCovList = rawCov.map(item => {
          let codeName = typeof item === 'string' ? item : (item.class_of_vehicle || item.code || item.cov || 'LMV');
          return {
            code: String(codeName || '').trim().toUpperCase(),
            issuedBy: issuingOfficeCode,
            doi: issueDateClean,
            category: 'NT'
          };
        });
      }

      const formattedDl = {
        dlNo: d.license_number || lookupKey,
        doi: issueDateClean,
        validUptoNT: formatDateDisplay(d.doe || d.nt_validity_to),
        validUptoTR: '',
        name: String(d.name || '').replace(/[\r\n]+/g, ' ').trim(),
        dob: formatDateDisplay(d.dob || cleanDob),
        swd: String(d.father_or_husband_name || 'NA').replace(/[\r\n]+/g, ' ').trim(),
        address: enrichAddress(d.permanent_address || d.temporary_address || '', d.ola_name, lookupKey),
        profileImage: (d.has_image && typeof d.profile_image === 'string') ? d.profile_image : '',
        covList: parsedCovList,
        rtoAuthority: String(d.ola_name || 'RTO OFFICE').trim()
      };
      return formattedDl;
    }
  } catch (err) {}
  return null;
}

const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

const oldDlBackLayout = {
  dlNo: { x: 92.0, yTop: 28.5, size: 6.8, maxW: 130 },
  doi: { x: 198.0, yTop: 28.5, size: 6.5, maxW: 65 },
  name: { x: 92.0, yTop: 36.5, size: 6.5, maxW: 140 },
  dob: { x: 92.0, yTop: 44.5, size: 6.5, maxW: 120 },
  validUptoNT: { x: 92.0, yTop: 52.5, size: 6.5, maxW: 130 },
  swd: { x: 92.0, yTop: 102.0, size: 6.5, maxW: 140 },
  address: { x: 92.0, yTop: 114.0, size: 5.5, multiLine: true, maxLines: 3, lineHeight: 5.2, maxW: 150 }
};

function getTemplatePath(candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(__dirname, 'public', 'assets', 'templates', candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

app.post('/api/create-order', orderLimiter, async (req, res) => {
  try {
    await ordersSecuritySchemaReady;
    const { docType, targetNumber, dob, rcFormat } = req.body;
    const localOrderId = 'ORD_' + Date.now();
    const amount = 150;
    
    let rzpOrderId = null;
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      const rzpOrder = await razorpay.orders.create({ amount: Math.round(amount * 100), currency: 'INR', receipt: localOrderId });
      rzpOrderId = rzpOrder.id;
    }

    const effectiveOrderId = rzpOrderId || localOrderId;
    orders.set(effectiveOrderId, { orderId: effectiveOrderId, docType, targetNumber, amount, dob, rcFormat, status: 'SUCCESS' });
    res.json({ success: true, orderId: effectiveOrderId, amount, amountPaise: Math.round(amount * 100), keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ error: 'Order creation failed' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  const { orderId } = req.body;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
  res.json({ status: 'SUCCESS', orderId: order.orderId, docType: order.docType, rcFormat: order.rcFormat || 'OLD', report });
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
  const { orderId } = req.body;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
  const pdfBuffer = await generateVectorPdfBuffer(order.docType, order.rcFormat || 'OLD', report);
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="DL_${report.dlNo || 'Document'}.pdf"`);
  res.send(pdfBuffer);
});

app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Backend Running at: http://localhost:${PORT}`);
});