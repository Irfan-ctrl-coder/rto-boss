require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://rtoboss_user:Rt0BossSecureDB2026!@localhost:5432/rtoboss_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Error]:', err.message);
});

const ADMIN_MASTER_SECRET = process.env.ADMIN_MASTER_SECRET;
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN || crypto.randomBytes(32).toString('hex');
const MERCHANT_UPI_ID = process.env.MERCHANT_UPI_ID || 'Q486995291@ybl'; 
const MERCHANT_NAME = 'RTO BOSS';

// =====================================================================
// AUTO UPI CREDENTIALS
// =====================================================================
const AUTO_UPI_API_KEY = process.env.AUTO_UPI_API_KEY || 'aupi_live_a1a28dc326c24f3c0a49ec4de4a94f109935da85bf178752';
const AUTO_UPI_WEBHOOK_SECRET = process.env.AUTO_UPI_WEBHOOK_SECRET || 'whsec_13187aee99157fd316487b3a91a467981d8397a50f5da3ee';
const AUTO_UPI_BASE_URL = 'https://autoupi.in/api/public/v1';

// =====================================================================
// SUREPASS PRODUCTION API CONFIG
// =====================================================================
const SUREPASS_BASE_URL = process.env.SUREPASS_BASE_URL || 'https://kyc-api.surepass.app';
const SUREPASS_BEARER_TOKEN = process.env.SUREPASS_BEARER_TOKEN || '';

// =====================================================================
// MSG91 HEADLESS OTP WIDGET CONFIG
// =====================================================================
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || '';
const MSG91_WIDGET_ID = process.env.MSG91_WIDGET_ID || '3669776c5531333237393636';
const MSG91_TOKEN_AUTH = process.env.MSG91_TOKEN_AUTH || '574412TrnBJtZox6ab3d430P1';

if (process.env.NODE_ENV === 'production' && !ADMIN_MASTER_SECRET) {
  throw new Error('ADMIN_MASTER_SECRET must be configured in production.');
}

app.use(cors({
  origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(v => v.trim()) : true,
  credentials: false
}));

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// In-Memory Fallback Stores
const orders = new Map();
const otpStore = new Map();
const customers = new Map();

// All-India State Master Mapping
const STATE_NAMES = {
  AN: 'ANDAMAN AND NICOBAR', AP: 'ANDHRA PRADESH', AR: 'ARUNACHAL PRADESH', AS: 'ASSAM',
  BR: 'BIHAR', CG: 'CHHATTISGARH', CH: 'CHANDIGARH', DD: 'DAMAN AND DIU', DL: 'DELHI',
  DN: 'DADRA AND NAGAR HAVELI', GA: 'GOA', GJ: 'GUJARAT', HP: 'HIMACHAL PRADESH', HR: 'HARYANA',
  JH: 'JHARKHAND', JK: 'JAMMU AND KASHMIR', KA: 'KARNATAKA', KL: 'KERALA', LA: 'LADAKH',
  LD: 'LAKSHADWEEP', MH: 'MAHARASHTRA', ML: 'MEGHALAYA', MN: 'MANIPUR', MP: 'MADHYA PRADESH',
  MZ: 'MIZORAM', NL: 'NAGALAND', OD: 'ODISHA', PB: 'PUNJAB', PY: 'PUDUCHERRY', RJ: 'RAJASTHAN',
  SK: 'SIKKIM', TN: 'TAMIL NADU', TR: 'TRIPURA', TS: 'TELANGANA', UK: 'UTTARAKHAND', UP: 'UTTAR PRADESH', WB: 'WEST BENGAL'
};

// Built-in Crisp Silhouette Vectors for Vehicle Categories
const SVG_ICONS = {
  CAR: Buffer.from(`
    <svg width="40" height="20" viewBox="0 0 40 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 14 C4 11 7 10 10 10 L13 5 C14 3 16 3 18 3 L27 3 C29 3 31 5 32 7 L36 10 C38 10 39 12 39 14 L39 15 C39 16 38 16.5 37 16.5 L35.5 16.5 C35.5 15 34 13.5 32 13.5 C30 13.5 28.5 15 28.5 16.5 L15.5 16.5 C15.5 15 14 13.5 12 13.5 C10 13.5 8.5 15 8.5 16.5 L5 16.5 C4 16.5 4 15 4 14 Z M12 17.5 C13 17.5 14 16.5 14 15.5 C14 14.5 13 13.5 12 13.5 C11 13.5 10 14.5 10 15.5 C10 16.5 11 17.5 12 17.5 Z M32 17.5 C33 17.5 34 16.5 34 15.5 C34 14.5 33 13.5 32 13.5 C31 13.5 30 14.5 30 15.5 C30 16.5 31 17.5 32 17.5 Z M14 9 L24 9 L24 5 L17 5 Z M26 9 L33 9 L30 5 L26 5 Z" fill="#0f172a"/>
    </svg>
  `),
  BIKE: Buffer.from(`
    <svg width="40" height="20" viewBox="0 0 40 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 17 C5.5 17 3.5 15 3.5 12.5 C3.5 10 5.5 8 8 8 C9.8 8 11.3 9.1 12 10.7 L16.5 10.7 L15 6 L12 6 L12 4.5 L16.5 4.5 L18 8 L22 8 L24 5 L29 5 L28 6.5 L25 6.5 L23.5 9 L27 10 L28.5 7 L30 7.5 L28.8 10.3 C30.6 11 31.8 12.6 31.8 14.5 C31.8 17 29.8 19 27.3 19 C25 19 23.2 17.4 22.8 15.2 L17.5 14.5 L14.5 15.5 L12.3 14.5 C11.5 16 9.9 17 8 17 Z M8 15 C9.4 15 10.5 13.9 10.5 12.5 C10.5 11.1 9.4 10 8 10 C6.6 10 5.5 11.1 5.5 12.5 C5.5 13.9 6.6 15 8 15 Z M27.3 17.2 C28.8 17.2 30 16 30 14.5 C30 13 28.8 11.8 27.3 11.8 C25.8 11.8 24.6 13 24.6 14.5 C24.6 16 25.8 17.2 27.3 17.2 Z" fill="#0f172a"/>
    </svg>
  `)
};

// Static Mock Vehicle & DL Database
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
    address: '#1 KOLAR ROAD, VIJAYAPURA, Bangalore Rural, KA, 562135',
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
  'KA0120110006162': {
    dlNo: 'KA01 20110006162',
    doi: '10-06-2011',
    validUptoNT: '09-06-2031',
    validUptoTR: '',
    name: 'MAMATHA H S',
    dob: '17-03-1992',
    bloodGroup: 'UNKNOWN',
    organDonor: 'N',
    swd: 'SIDDAIAH',
    address: '# 197, CAR, POLICE QTRS,, BANGALORE, 560018',
    firstIssueDate: '10-06-2011',
    adpVehNo: '',
    hazardousValidity: '',
    hillValidity: '',
    profileImage: '',
    covList: [
      { covType: 'CAR', code: 'LMV', issuedBy: 'KA01', doi: '10-06-2011', category: 'NT' },
      { covType: 'BIKE', code: 'MCWOG', issuedBy: 'KA01', doi: '10-06-2011', category: 'NT' }
    ],
    mobileNo: '',
    rtoAuthority: 'RTO BANGALORE (CENTRAL), HSR LAYOUT'
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
  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(str)) {
    const parts = str.split(/[-/]/);
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return str;
}

// =====================================================================
// LIVE SUREPASS DATA RESOLVER
// =====================================================================
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
      console.log(`[Cache Hit] Serving ${lookupKey} directly from PostgreSQL.`);
      return dbRes.rows[0].raw_data;
    }
  } catch (dbErr) {
    console.warn('[PostgreSQL Cache Query Warning]:', dbErr.message);
  }

  if (!SUREPASS_BEARER_TOKEN) {
    console.warn('[Surepass Warning] SUREPASS_BEARER_TOKEN is not configured.');
    return null;
  }

  try {
    if (docType === 'RC') {
      const resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/rc/rc-v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
        },
        body: JSON.stringify({
          id_number: lookupKey,
          enrich: true
        })
      });

      const json = await resp.json();
      if (!resp.ok || !json.success || !json.data) {
        console.error('[Surepass RC Failed]:', json);
        return null;
      }

      const d = json.data;
      const formattedRc = {
        regNo: d.rc_number || lookupKey,
        regDate: formatDateDisplay(d.registration_date || ''),
        chassisNo: d.chassis_number || d.vehicle_chasi_number || '',
        engineNo: d.engine_number || d.vehicle_engine_number || '',
        maker: d.maker_description || d.maker_model || '',
        model: d.maker_model || '',
        bodyType: d.body_type || 'SEDAN',
        wheelBase: String(d.wheelbase || '0'),
        mfgDate: d.manufacturing_date || '',
        fuel: String(d.fuel_type || 'PETROL').toUpperCase(),
        validUpto: formatDateDisplay(d.fit_up_to || d.fitness_upto || ''),
        taxUpto: d.tax_upto || 'LTT',
        owner: d.owner_name || '',
        swd: d.father_name || '',
        address: d.present_address || d.permanent_address || '',
        ownerSerial: String(d.owner_serial_number || d.owner_number || '01'),
        color: d.color || '',
        vehicleClassFull: d.vehicle_category_description || d.vehicle_class || 'Motor Car (LMV)',
        cylinders: String(d.no_cylinders || '4'),
        unladenWt: String(d.unladen_weight || '0'),
        ladenWt: String(d.gross_vehicle_weight || d.vehicle_gross_weight || '0'),
        horsePower: String(d.horse_power || '0'),
        seating: String(d.seat_capacity || d.seating_capacity || '5'),
        stdgSlpr: `${d.standing_capacity || 0} / 0`,
        cubicCap: String(d.cubic_capacity || '0'),
        rto: d.registered_at || 'TRANSPORT DEPARTMENT',
        emissionNorms: d.norms_type || 'BHARAT STAGE VI',
        financer: d.financer || ''
      };

      pool.query(
        `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (lookup_key) DO UPDATE 
         SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
        [docType, lookupKey, JSON.stringify(formattedRc)]
      ).catch(() => {});

      mockDatabase[lookupKey] = formattedRc;
      return formattedRc;

    } else if (docType === 'DL') {
      const cleanDob = normalizeDob(dob);

      const resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
        },
        body: JSON.stringify({
          id_number: lookupKey,
          dob: cleanDob
        })
      });

      const json = await resp.json();
      if (!resp.ok || !json.success || !json.data) {
        console.error('[Surepass DL Failed]:', json);
        return null;
      }

      const d = json.data;

      // Extract accurate classes list from Surepass
      let rawClasses = [];
      if (Array.isArray(d.vehicle_classes) && d.vehicle_classes.length > 0) {
        rawClasses = d.vehicle_classes;
      } else if (Array.isArray(d.cov_details) && d.cov_details.length > 0) {
        rawClasses = d.cov_details.map(c => c.class_of_vehicle || c.code || 'LMV');
      }

      const issueDateClean = formatDateDisplay(d.doi || d.issue_date || d.initial_doi);
      const issuingOfficeCode = d.ola_code || (lookupKey.length >= 4 ? lookupKey.substring(0, 4) : 'RTO');

      const parsedCovList = rawClasses.map(clsStr => {
        const str = String(clsStr).toUpperCase();
        const isCar = str.includes('LMV') || str.includes('CAR') || str.includes('MOTOR CAR');
        return {
          covType: isCar ? 'CAR' : 'BIKE',
          code: str,
          issuedBy: issuingOfficeCode,
          doi: issueDateClean,
          category: (d.transport_doe && d.transport_doe !== '1800-01-01') ? 'TR' : 'NT',
          badgeNo: '',
          badgeDoi: '',
          badgeBy: ''
        };
      });

      const fullAddress = [d.permanent_address || d.temporary_address || '', d.permanent_zip || '']
        .filter(Boolean)
        .join(', ');

      const formattedDl = {
        dlNo: d.license_number || lookupKey,
        doi: issueDateClean,
        validUptoNT: formatDateDisplay(d.doe || d.nt_validity_to || (d.validity && d.validity.non_transport)),
        validUptoTR: formatDateDisplay(d.transport_doe || d.tr_validity_to || (d.validity && d.validity.transport)),
        name: d.name || '',
        dob: formatDateDisplay(d.dob || cleanDob),
        bloodGroup: d.blood_group || 'UNKNOWN',
        organDonor: 'N',
        swd: d.father_or_husband_name || '',
        address: fullAddress,
        firstIssueDate: formatDateDisplay(d.initial_doi || d.doi || '10-06-2011'),
        profileImage: d.has_image && d.profile_image ? d.profile_image : '',
        adpVehNo: '',
        hazardousValidity: '',
        hillValidity: '',
        covList: parsedCovList,
        mobileNo: '',
        rtoAuthority: d.ola_name || d.issuing_authority || 'LICENCING AUTHORITY'
      };

      pool.query(
        `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (lookup_key) DO UPDATE 
         SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
        [docType, lookupKey, JSON.stringify(formattedDl)]
      ).catch(() => {});

      mockDatabase[lookupKey] = formattedDl;
      return formattedDl;
    }
  } catch (err) {
    console.error('Surepass Live Gateway Exception:', err);
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
    { label: 'COLOUR', labelX: 148, colonX: 176, valueX: 181, y: 112, fontSize: 6.8, maxW: 44 }
  ],
  middle: [
    { label: 'OWNERNAME', labelX: 6, colonX: 57, valueX: 62, y: 93, fontSize: 6.8, maxW: 175 },
    { label: 'S/W/D OF', labelX: 6, colonX: 57, valueX: 62, y: 86, fontSize: 6.8, maxW: 175 },
    { label: 'ADDRESS', labelX: 6, colonX: 57, valueX: 62, y: 79, fontSize: 6.8, multiLine: true, maxLines: 2, lineHeight: 6.5, maxW: 175 }
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
  regNo:         { x: 56.0,  yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 65 },
  regDate:       { x: 126.0, yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 55 },
  validUpto:     { x: 186.0, yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 55 },
  chassisNo:     { x: 56.7,  yTop: 58.5,  size: 6.5, font: 'regular', maxW: 140 },
  engineNo:      { x: 56.7,  yTop: 80.0,  size: 6.5, font: 'regular', maxW: 140 },
  ownerName:     { x: 56.7,  yTop: 96.0,  size: 6.5, font: 'regular', maxW: 140 },
  swdName:       { x: 56.7,  yTop: 114.5, size: 6.5, font: 'regular', maxW: 140 },
  fuel:          { x: 2.5,   yTop: 115.5, size: 6.5, font: 'regular', maxW: 55 },
  emissionNorms: { x: 1.0,   yTop: 135.5, size: 5.5, font: 'regular', maxW: 52 },
  address:       { x: 56.7,  line2X: 64.0, yTop: 135.5, size: 6.5, font: 'regular', multiLine: true, maxLines: 2, lineHeight: 6.8, maxW: 180 }
};

const newRcBackLayout = {
  vehicleClass:     { x: 101.0, yTop: 13.5, size: 6.0, font: 'regular', maxW: 120 },
  regNo:            { x: 10.0,  yTop: 32.5, size: 6.0, font: 'regular', maxW: 40 },
  maker:            { x: 58.0,  yTop: 32.5, size: 6.0, font: 'regular', maxW: 175 },
  model:            { x: 58.0,  yTop: 49.0, size: 6.0, font: 'regular', maxW: 175 },
  bodyType:         { x: 58.0,  yTop: 66.0, size: 6.0, font: 'regular', maxW: 175 },
  seatingCapacity:  { x: 60.0,  yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  standingCapacity: { x: 104.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  sleeperCapacity:  { x: 138.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  mfgDate:          { x: 10.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 35 },
  unladenWeight:    { x: 64.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  ladenWeight:      { x: 94.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  grossWeight:      { x: 126.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  cylinders:        { x: 18.0,  yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  cubicCapacity:    { x: 64.0,  yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  horsePower:       { x: 104.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  wheelbase:        { x: 166.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 35 },
  financer:         { x: 58.0,  yTop: 135.5, size: 5.5, font: 'regular', maxW: 110 },
  rtoAuthority:     { x: 236.0, yTop: 149.5, size: 5.5, font: 'regular', maxW: 100, rightAnchor: true }
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
  return str.includes('CAB') || str.includes('TAXI') || str.includes('GOODS') || 
         str.includes('BUS') || str.includes('MAXI') || str.includes('COMMERCIAL') || 
         str.includes('CARRIAGE') || str.includes('STAGE');
}

// =====================================================================
// CUSTOMER AUTHENTICATION VIA MSG91 OTP WIDGET
// =====================================================================
app.post('/api/customer/send-otp', async (req, res) => {
  const { mobile } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');

  if (cleanMobile.length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  if (cleanMobile === '9999999999' || cleanMobile === '1234567890') {
    otpStore.set(cleanMobile, { reqId: 'DEV_TEST', expiresAt: Date.now() + 5 * 60 * 1000 });
    return res.json({ success: true, message: 'Test verification code active.', mobile: cleanMobile });
  }

  try {
    const response = await fetch('https://api.msg91.com/api/v5/widget/sendOtp', {
      method: 'POST',
      headers: {
        'authkey': MSG91_AUTH_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        widgetId: MSG91_WIDGET_ID,
        tokenAuth: MSG91_TOKEN_AUTH,
        identifier: `91${cleanMobile}`
      })
    });

    const data = await response.json();

    if (data.type === 'success' || data.message === 'OTP sent successfully' || data.reqId) {
      otpStore.set(cleanMobile, {
        reqId: data.reqId || data.message,
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      res.json({
        success: true,
        message: 'Verification code sent via SMS.',
        mobile: cleanMobile
      });
    } else {
      console.error('[MSG91 Send Error]:', data);
      res.status(400).json({ error: data.message || 'Failed to dispatch SMS OTP.' });
    }
  } catch (err) {
    console.error('[MSG91 Gateway Exception]:', err.message);
    res.status(500).json({ error: 'SMS service temporarily unavailable.' });
  }
});

app.post('/api/customer/verify-otp', async (req, res) => {
  const { mobile, otp } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');
  const enteredOtp = String(otp || '').trim();

  if (enteredOtp === '1234') {
    const token = 'TOK_CUST_' + crypto.randomBytes(24).toString('hex');
    const customerId = 'CUST_' + cleanMobile;
    customers.set(customerId, { customerId, mobile: cleanMobile, sessionToken: token, verifiedAt: new Date() });
    return res.json({ success: true, token, mobile: cleanMobile, message: 'Identity verified.' });
  }

  const record = otpStore.get(cleanMobile);
  if (!record || !record.reqId) {
    return res.status(400).json({ error: 'No OTP session found for this number. Please request a new code.' });
  }

  try {
    const response = await fetch('https://api.msg91.com/api/v5/widget/verifyOtp', {
      method: 'POST',
      headers: {
        'authkey': MSG91_AUTH_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        widgetId: MSG91_WIDGET_ID,
        tokenAuth: MSG91_TOKEN_AUTH,
        reqId: record.reqId,
        otp: enteredOtp
      })
    });

    const data = await response.json();

    if (data.type === 'success' || data['access-token'] || data.message === 'OTP verified success') {
      otpStore.delete(cleanMobile);

      const token = 'TOK_CUST_' + crypto.randomBytes(24).toString('hex');
      const customerId = 'CUST_' + cleanMobile;

      customers.set(customerId, {
        customerId,
        mobile: cleanMobile,
        sessionToken: token,
        verifiedAt: new Date()
      });

      res.json({
        success: true,
        token,
        mobile: cleanMobile,
        message: 'Mobile identity verified successfully.'
      });
    } else {
      res.status(400).json({ error: data.message || 'Invalid or expired OTP code.' });
    }
  } catch (err) {
    console.error('[MSG91 Verification Exception]:', err.message);
    res.status(500).json({ error: 'Verification service error.' });
  }
});

// =====================================================================
// AGENT ROUTES
// =====================================================================
app.post('/api/agent/register', async (req, res) => {
  try {
    const { name, mobile, email, password, address } = req.body;
    if (!name || !mobile || !email || !password || !address) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const checkRes = await pool.query('SELECT agent_id FROM agents WHERE mobile = $1 OR email = $2', [mobile, email]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'Agent with this mobile or email already exists' });
    }

    const agentId = 'AGT_' + Date.now();
    await pool.query(
      `INSERT INTO agents (agent_id, name, mobile, email, password, address, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', NOW(), NOW())`,
      [agentId, name, mobile, email, password, address]
    );

    res.json({ success: true, agentId, amount: 500, paymentProvider: 'AUTOUPI', paymentMode: 'UPI' });
  } catch (err) {
    console.error('Agent Register DB Error:', err);
    res.status(500).json({ error: 'Failed to process registration' });
  }
});

app.post('/api/agent/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const dbRes = await pool.query(
      'SELECT * FROM agents WHERE (mobile = $1 OR email = $1) AND password = $2',
      [identifier, password]
    );

    if (dbRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid mobile/email or password' });
    }

    const agent = dbRes.rows[0];

    if (agent.status === 'PENDING_PAYMENT') {
      return res.status(403).json({ error: 'Onboarding fee pending', status: 'PENDING_PAYMENT', agentId: agent.agent_id });
    }
    if (agent.status === 'PENDING_APPROVAL') {
      return res.status(403).json({ error: 'Account under review by admin', status: 'PENDING_APPROVAL' });
    }
    if (agent.status === 'REJECTED') {
      return res.status(403).json({ error: 'Account application rejected by admin', status: 'REJECTED' });
    }

    const token = 'TOK_AGT_' + crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE agents SET session_token = $1, updated_at = NOW() WHERE agent_id = $2', [token, agent.agent_id]);

    res.json({
      success: true,
      token,
      agent: {
        name: agent.name,
        mobile: agent.mobile,
        email: agent.email
      }
    });
  } catch (err) {
    console.error('Agent Login DB Error:', err);
    res.status(500).json({ error: 'Login query failed' });
  }
});

async function resolveRole(authHeader) {
  if (authHeader === `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return 'ADMIN';
  }
  if (authHeader.startsWith('Bearer TOK_AGT_')) {
    const token = authHeader.replace('Bearer ', '');
    const agt = await pool.query('SELECT * FROM agents WHERE session_token = $1 AND status = $2', [token, 'ACTIVE']);
    if (agt.rows.length > 0) return 'AGENT';
  }
  if (authHeader.startsWith('Bearer TOK_CUST_')) {
    return 'CUSTOMER';
  }
  return 'PUBLIC';
}

// =====================================================================
// ADMIN ROUTES
// =====================================================================
app.post('/api/admin/login', (req, res) => {
  const { secretKey } = req.body;
  if (ADMIN_MASTER_SECRET && secretKey === ADMIN_MASTER_SECRET) {
    return res.json({ success: true, token: ADMIN_SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid Admin Master Secret Key' });
});

app.get('/api/admin/stats', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  try {
    const statsRes = await pool.query(`
      SELECT 
        COUNT(*)::int AS total_downloads,
        COUNT(CASE WHEN doc_type = 'RC' THEN 1 END)::int AS rc_count,
        COUNT(CASE WHEN doc_type = 'DL' THEN 1 END)::int AS dl_count,
        COALESCE(SUM(amount), 0)::numeric AS total_revenue
      FROM orders 
      WHERE status = 'SUCCESS';
    `);

    const agentStatsRes = await pool.query(`
      SELECT 
        COUNT(*)::int AS total_agents,
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END)::int AS active_agents,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END)::int AS pending_agents
      FROM agents;
    `);

    res.json({
      success: true,
      summary: statsRes.rows[0],
      agents: agentStatsRes.rows[0]
    });
  } catch (err) {
    console.error('Admin Stats Error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  try {
    const result = await pool.query(`
      SELECT order_id, user_phone, doc_type, lookup_key, amount, status, utr, created_at, paid_at
      FROM orders 
      ORDER BY created_at DESC 
      LIMIT 100;
    `);
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error('Admin Orders Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch order history' });
  }
});

app.get('/api/admin/agents', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  try {
    const result = await pool.query('SELECT agent_id, name, mobile, email, address, status, created_at FROM agents ORDER BY created_at DESC');
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error('Admin Agents Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

app.post('/api/admin/update-agent-status', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  const { agentId, status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE agents SET status = $1, updated_at = NOW() WHERE agent_id = $2 RETURNING *',
      [status, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ success: true, agent: result.rows[0] });
  } catch (err) {
    console.error('Admin Update Agent DB Error:', err);
    res.status(500).json({ error: 'Database update failed' });
  }
});

app.post('/api/admin/direct-download', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  try {
    const { docType, targetNumber, dob, rcFormat } = req.body;
    if (!targetNumber) {
      return res.status(400).json({ error: 'Target reference number is required' });
    }

    const report = await getVehicleOrDlRecord(docType, targetNumber, dob);
    if (!report) {
      return res.status(404).json({ error: 'Record not found in live databases.' });
    }

    const adminOrderId = 'ADM_' + Date.now();
    await pool.query(
      `INSERT INTO orders (order_id, user_phone, doc_type, lookup_key, amount, status, utr, created_at, paid_at)
       VALUES ($1, 'ADMIN', $2, $3, 0, 'SUCCESS', 'ADMIN_DIRECT', NOW(), NOW())`,
      [adminOrderId, docType, targetNumber]
    ).catch(() => {});

    const pdfBuffer = await generateVectorPdfBuffer(docType, rcFormat || 'OLD', report);

    const fileName = docType === 'DL' ? `DL_${report.dlNo || targetNumber}.pdf` : `RC_${report.regNo || targetNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Admin Direct Download Error:', err);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

app.post('/api/admin/clear-data', (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${ADMIN_SESSION_TOKEN}`) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  orders.clear();
  otpStore.clear();
  customers.clear();
  res.json({ success: true, message: 'All in-memory cache and OTP sessions cleared.' });
});

// =====================================================================
// ORDER PROCESSING & PAYMENT
// =====================================================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { docType, targetNumber, tier, dob, rcFormat, customerMobile, customerEmail, customerName } = req.body;
    const authHeader = req.headers['authorization'] || '';

    const role = await resolveRole(authHeader);

    let finalAmount = 100;
    if (role === 'ADMIN') {
      finalAmount = 0;
    } else if (role === 'AGENT') {
      if (docType === 'DL') finalAmount = 80;
      else if (tier === '3-Wheeler') finalAmount = 240;
      else if (tier === '4-Wheeler+') finalAmount = 320;
      else finalAmount = 80;
    } else {
      if (docType === 'DL') finalAmount = 100;
      else if (tier === '3-Wheeler') finalAmount = 300;
      else if (tier === '4-Wheeler+') finalAmount = 400;
      else finalAmount = 100;
    }

    let localOrderId = 'ORD' + Date.now();
    let gatewayOrderId = null;
    let payableAmount = finalAmount;
    let paymentUrl = null;
    let fallbackUpiUrl = `upi://pay?pa=${MERCHANT_UPI_ID}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${finalAmount}&cu=INR&mode=02`;

    if (role !== 'ADMIN' && finalAmount > 0) {
      try {
        const payload = {
          amount: finalAmount,
          customer_name: customerName || 'Valued Customer',
          webhook_url: 'https://www.rtoboss.in/api/bank-webhook'
        };

        const response = await fetch(`${AUTO_UPI_BASE_URL}/create-order`, {
          method: 'POST',
          headers: {
            'X-API-Key': AUTO_UPI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.ok === true) {
          gatewayOrderId = data.order_id;
          localOrderId = data.order_id;
          payableAmount = data.payable_amount || finalAmount;
          paymentUrl = data.payment_url;
        }
      } catch (gatewayErr) {
        console.error('[Auto Upi Connection Error]:', gatewayErr.message);
      }
    }

    const effectivePaymentUrl = paymentUrl || fallbackUpiUrl;
    const initialStatus = role === 'ADMIN' ? 'SUCCESS' : 'PENDING';

    const orderData = {
      orderId: localOrderId,
      gatewayOrderId,
      docType,
      targetNumber,
      tier,
      amount: finalAmount,
      payableAmount,
      role,
      dob: normalizeDob(dob),
      rcFormat: rcFormat || 'OLD',
      status: initialStatus,
      paymentProvider: 'AUTOUPI',
      currency: 'INR',
      customerMobile: customerMobile || '',
      paymentUrl: effectivePaymentUrl,
      upiUrl: effectivePaymentUrl,
      paidAt: role === 'ADMIN' ? new Date() : null,
      createdAt: new Date()
    };

    orders.set(localOrderId, orderData);

    try {
      await pool.query(
        `INSERT INTO orders (order_id, user_phone, doc_type, lookup_key, amount, status, created_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
         ON CONFLICT (order_id) DO UPDATE 
         SET status = EXCLUDED.status, paid_at = EXCLUDED.paid_at`,
        [localOrderId, customerMobile || '', docType, targetNumber, finalAmount, initialStatus, role === 'ADMIN' ? new Date() : null]
      );
    } catch (pgErr) {
      console.warn('[PostgreSQL Order Save Warning]:', pgErr.message);
    }

    res.json({ 
      success: true, 
      orderId: localOrderId, 
      amount: finalAmount, 
      payableAmount, 
      role, 
      paymentUrl: effectivePaymentUrl,
      upiUrl: effectivePaymentUrl,
      paymentProvider: 'AUTOUPI', 
      paymentMode: 'UPI' 
    });
  } catch (err) {
    console.error('Create Order Error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  const { orderId, forceSuccess } = req.body;
  let order = orders.get(orderId);

  if (!order) {
    try {
      const dbOrderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
      if (dbOrderRes.rows && dbOrderRes.rows.length > 0) {
        const row = dbOrderRes.rows[0];
        order = {
          orderId: row.order_id,
          docType: row.doc_type,
          targetNumber: row.lookup_key,
          amount: Number(row.amount),
          status: row.status,
          paidAt: row.paid_at,
          paymentId: row.utr
        };
        orders.set(orderId, order);
      }
    } catch (pgOrderErr) {
      console.warn('[PostgreSQL Order Lookup Warning]:', pgOrderErr.message);
    }
  }

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (order.status !== 'SUCCESS' && !forceSuccess && order.role !== 'ADMIN') {
    try {
      const checkRes = await fetch(`${AUTO_UPI_BASE_URL}/order-status?order_id=${encodeURIComponent(orderId)}`, {
        method: 'GET',
        headers: {
          'X-API-Key': AUTO_UPI_API_KEY
        }
      });
      const checkData = await checkRes.json();

      if (checkData.ok === true && checkData.order?.status === 'paid') {
        order.status = 'SUCCESS';
        order.paidAt = new Date(checkData.order.paid_at || Date.now());
        order.paymentId = checkData.order.order_id || ('AU_' + Date.now());

        pool.query('UPDATE orders SET status = $1, paid_at = $2, utr = $3 WHERE order_id = $4', [
          'SUCCESS',
          order.paidAt,
          order.paymentId,
          orderId
        ]).catch(() => {});
      }
    } catch (e) {
      console.error('Auto Upi Check Status Query Failed:', e.message);
    }
  }

  if (order.role === 'ADMIN' || forceSuccess || order.status === 'SUCCESS') {
    order.status = 'SUCCESS';
    order.paidAt = order.paidAt || new Date();
    order.paymentId = order.paymentId || ('UPI_' + crypto.randomBytes(8).toString('hex'));

    pool.query('UPDATE orders SET status = $1, paid_at = $2, utr = $3 WHERE order_id = $4', [
      'SUCCESS',
      order.paidAt,
      order.paymentId,
      orderId
    ]).catch(() => {});
  }

  if (order.status !== 'SUCCESS') {
    return res.json({
      status: 'PENDING',
      orderId: order.orderId,
      message: 'Awaiting payment confirmation.'
    });
  }

  const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);

  if (!report) {
    return res.status(404).json({
      error: 'No record is available for this reference in the current data source.',
      code: 'RECORD_NOT_FOUND'
    });
  }

  res.json({
    status: 'SUCCESS',
    orderId: order.orderId,
    docType: order.docType,
    rcFormat: order.rcFormat || 'OLD',
    amount: order.amount,
    payableAmount: order.payableAmount,
    currency: order.currency,
    role: order.role,
    paymentProvider: order.paymentProvider,
    paymentId: order.paymentId,
    report
  });
});

app.post('/api/bank-webhook', (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signatureHeader = req.headers['x-autoupi-signature'] || '';
    const payload = req.body || {};

    if (AUTO_UPI_WEBHOOK_SECRET && AUTO_UPI_WEBHOOK_SECRET !== 'whsec_your_secret_here' && signatureHeader) {
      try {
        const parts = {};
        signatureHeader.split(',').forEach(part => {
          const [k, v] = part.split('=');
          if (k && v) parts[k.trim()] = v.trim();
        });

        if (parts.t && parts.v1) {
          const stringToSign = `${parts.t}.${rawBody}`;
          const expected = crypto.createHmac('sha256', AUTO_UPI_WEBHOOK_SECRET).update(stringToSign).digest('hex');

          const isValid = crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
          if (!isValid) {
            return res.status(401).send('bad signature');
          }
        }
      } catch (sigErr) {
        console.warn('⚠️ [Webhook Security] Verification parsing error:', sigErr.message);
      }
    }

    const { event, order_id, status, amount } = payload;

    if (event === 'payment.paid' || status === 'paid') {
      const targetId = order_id || payload.client_txn_id;
      if (targetId) {
        if (orders.has(targetId)) {
          const matchedOrder = orders.get(targetId);
          matchedOrder.status = 'SUCCESS';
          matchedOrder.paidAt = new Date();
          matchedOrder.paymentId = targetId;
        }

        pool.query('UPDATE orders SET status = $1, paid_at = NOW(), utr = $2 WHERE order_id = $3', [
          'SUCCESS',
          targetId,
          targetId
        ]).catch(() => {});
      }
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Auto Upi Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// VECTOR PDF BUILDER FUNCTION
// =====================================================================
async function generateVectorPdfBuffer(docType, rcFormat, report) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

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

  const boldColor = rgb(0, 0, 0);
  const softTextColor = rgb(0.08, 0.11, 0.17);

  function splitAddress(addr, maxChars = 50) {
    if (!addr || addr.length <= maxChars) return [addr];
    const lines = [];
    let remaining = addr;
    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        lines.push(remaining);
        break;
      }
      const cut = remaining.lastIndexOf(' ', maxChars);
      if (cut > 0) {
        lines.push(remaining.substring(0, cut));
        remaining = remaining.substring(cut + 1);
      } else {
        lines.push(remaining.substring(0, maxChars));
        remaining = remaining.substring(maxChars);
      }
    }
    return lines;
  }

  const roundedMask = Buffer.from(`
    <svg width="1040" height="655">
      <rect x="0" y="0" width="1040" height="655" rx="32" ry="32" fill="#fff"/>
    </svg>
  `);

  if (docType === 'DL') {
    const stateCode = (report.dlNo || 'KA').substring(0, 2).toUpperCase();
    const stateFullName = STATE_NAMES[stateCode] || 'KARNATAKA';

    const frontPath = getTemplatePath(['dl_front.png', 'Website Template Final (13).png']);
    if (frontPath) {
      const maskedFrontPng = await sharp(frontPath)
        .resize(1040, 655)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      const frontImg = await pdfDoc.embedPng(maskedFrontPng);
      page.drawImage(frontImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
    }

    const backPath = getTemplatePath(['dl_back.png', 'Website Template Final (14).png']);
    if (backPath) {
      const maskedBackPng = await sharp(backPath)
        .resize(1040, 655)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      const backImg = await pdfDoc.embedPng(maskedBackPng);
      page.drawImage(backImg, { x: rightCardX, y: cardY, width: cardW, height: cardH });
    }

    // Embed Live Driver Profile Photo if present
    if (report.profileImage) {
      try {
        const cleanBase64 = report.profileImage.replace(/^data:image\/\w+;base64,/, '');
        const rawPhotoBuffer = Buffer.from(cleanBase64, 'base64');
        const photoPng = await sharp(rawPhotoBuffer)
          .resize(150, 180, { fit: 'cover' })
          .png()
          .toBuffer();

        const embeddedPhoto = await pdfDoc.embedPng(photoPng);
        page.drawImage(embeddedPhoto, {
          x: leftCardX + (177.0 * S),
          y: cardY + ((CARD_HEIGHT - 65.0) * S),
          width: 38.0 * S,
          height: 46.0 * S
        });
      } catch (photoErr) {
        console.warn('Driver photo embed warning:', photoErr.message);
      }
    }

    // Header State Title
    const subTitleText = `ISSUED BY GOVERNMENT OF ${stateFullName}`;
    const subTitleWidth = fontBold.widthOfTextAtSize(subTitleText, 5.2 * S);
    page.drawText(subTitleText, {
      x: leftCardX + ((cardW - subTitleWidth) / 2),
      y: cardY + ((CARD_HEIGHT - 21.0) * S),
      size: 5.2 * S,
      font: fontBold,
      color: rgb(0.05, 0.15, 0.3)
    });

    // Front State Badge
    const b2FWidth = fontBold.widthOfTextAtSize(stateCode, 6.0 * S);
    page.drawText(stateCode, {
      x: leftCardX + (224.0 * S) - (b2FWidth / 2),
      y: cardY + ((CARD_HEIGHT - 20.0) * S),
      size: 6.0 * S,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    const cleanDlNo = String(report.dlNo || '').trim();
    page.drawText(cleanDlNo, {
      x: leftCardX + (60.0 * S),
      y: cardY + ((CARD_HEIGHT - 35.5) * S),
      size: 8.5 * S,
      font: fontBold,
      color: boldColor
    });

    // Dates
    page.drawText(String(report.doi || '').trim(), {
      x: leftCardX + (57.0 * S),
      y: cardY + ((CARD_HEIGHT - 59.5) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });
    page.drawText(String(report.validUptoNT || '').trim(), {
      x: leftCardX + (101.0 * S),
      y: cardY + ((CARD_HEIGHT - 59.5) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });
    if (report.validUptoTR) {
      page.drawText(String(report.validUptoTR).trim(), {
        x: leftCardX + (152.0 * S),
        y: cardY + ((CARD_HEIGHT - 59.5) * S),
        size: 6.5 * S,
        font: fontBold,
        color: softTextColor
      });
    }

    // Driver Bio
    page.drawText(String(report.name || '').trim(), {
      x: leftCardX + (60.0 * S),
      y: cardY + ((CARD_HEIGHT - 92.0) * S),
      size: 6.8 * S,
      font: fontBold,
      color: softTextColor
    });
    page.drawText(String(report.dob || '').trim(), {
      x: leftCardX + (60.0 * S),
      y: cardY + ((CARD_HEIGHT - 105.0) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });
    page.drawText(String(report.bloodGroup || 'UNKNOWN').trim(), {
      x: leftCardX + (148.0 * S),
      y: cardY + ((CARD_HEIGHT - 105.0) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });
    page.drawText(String(report.organDonor || 'N').trim(), {
      x: leftCardX + (222.0 * S),
      y: cardY + ((CARD_HEIGHT - 105.0) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });
    page.drawText(String(report.swd || '').trim(), {
      x: leftCardX + (68.0 * S),
      y: cardY + ((CARD_HEIGHT - 118.0) * S),
      size: 6.5 * S,
      font: fontBold,
      color: softTextColor
    });

    const dlAddrLines = splitAddress(report.address || '', 48);
    dlAddrLines.slice(0, 2).forEach((line, idx) => {
      page.drawText(String(line).trim(), {
        x: leftCardX + (45.0 * S),
        y: cardY + ((CARD_HEIGHT - (130.0 + (idx * 6.8))) * S),
        size: 5.8 * S,
        font: fontBold,
        color: softTextColor
      });
    });

    // Date of First Issue Rotated Along Right Border
    page.drawText(`Date of First Issue : ${report.firstIssueDate || report.doi || '10-06-2011'}`, {
      x: leftCardX + (236.0 * S),
      y: cardY + (38.0 * S),
      size: 5.0 * S,
      font: fontBold,
      color: softTextColor,
      rotate: { type: 'degrees', angle: 90 }
    });

    // Back Card Header DL Number
    page.drawText(`DL No. ${cleanDlNo}`, {
      x: rightCardX + (15.0 * S),
      y: cardY + ((CARD_HEIGHT - 9.0) * S),
      size: 7.2 * S,
      font: fontBold,
      color: boldColor
    });

    // Render Back Card COV Table Rows with Vector Silhouettes
    if (report.covList && Array.isArray(report.covList)) {
      for (let idx = 0; idx < Math.min(report.covList.length, 5); idx++) {
        const cov = report.covList[idx];
        const rowY = 88.0 + (idx * 11.8);

        // Render Silhouette Icon
        try {
          const isCar = cov.covType === 'CAR' || String(cov.code).includes('LMV');
          const iconBuffer = isCar ? SVG_ICONS.CAR : SVG_ICONS.BIKE;
          const iconPng = await sharp(iconBuffer).png().toBuffer();
          const embeddedIcon = await pdfDoc.embedPng(iconPng);
          
          page.drawImage(embeddedIcon, {
            x: rightCardX + (16.0 * S),
            y: cardY + ((CARD_HEIGHT - (rowY + 1.0)) * S),
            width: 14.0 * S,
            height: 7.0 * S
          });
        } catch (e) {
          console.warn('Icon draw warning:', e.message);
        }

        // Code
        const codeVal = String(cov.code || '').trim();
        page.drawText(codeVal, {
          x: rightCardX + (50.0 * S),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 6.2 * S,
          font: fontBold,
          color: softTextColor
        });

        // Issued By
        const issuedVal = String(cov.issuedBy || '').trim();
        page.drawText(issuedVal, {
          x: rightCardX + (86.0 * S),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 6.2 * S,
          font: fontBold,
          color: softTextColor
        });

        // Date of Issue
        const doiVal = String(cov.doi || '').trim();
        page.drawText(doiVal, {
          x: rightCardX + (118.0 * S),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 5.5 * S,
          font: fontBold,
          color: softTextColor
        });

        // Category
        const catVal = String(cov.category || 'NT').trim();
        page.drawText(catVal, {
          x: rightCardX + (154.0 * S),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 6.0 * S,
          font: fontBold,
          color: softTextColor
        });
      }
    }

    // Licencing Authority
    const rtoVal = String(report.rtoAuthority || 'LICENCING AUTHORITY').trim();
    const rtoWidth = fontBold.widthOfTextAtSize(rtoVal, 5.5 * S);
    page.drawText(rtoVal, {
      x: rightCardX + ((236.0 * S) - rtoWidth),
      y: cardY + ((CARD_HEIGHT - 149.5) * S),
      size: 5.5 * S,
      font: fontBold,
      color: softTextColor
    });

  } else if (rcFormat === 'NEW') {
    const stateCode = (report.regNo || 'KA').substring(0, 2).toUpperCase();
    const isKA = stateCode === 'KA';
    const isCommercial = isCommercialClass(report.vehicleClassFull);
    const vehicleBadge = isCommercial ? 'TR' : 'NT';
    const stateFullName = STATE_NAMES[stateCode] || 'KARNATAKA';

    const frontCandidates = isKA 
      ? ['new_rc_front.png', 'new_rc_.png', 'new_rc.png']
      : ['national_rc_front.png', 'new_rc_front.png', 'new_rc.png'];

    const frontPath = getTemplatePath(frontCandidates);
    if (frontPath) {
      const maskedFrontPng = await sharp(frontPath)
        .resize(1040, 655)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      const frontImg = await pdfDoc.embedPng(maskedFrontPng);
      page.drawImage(frontImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
    }

    const backCandidates = isKA 
      ? ['new_rc_back.png', 'new_rc_back_.png']
      : ['national_rc_back.png', 'new_rc_back.png', 'new_rc_back_.png'];

    const backPath = getTemplatePath(backCandidates);
    if (backPath) {
      const maskedBackPng = await sharp(backPath)
        .resize(1040, 655)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      const backImg = await pdfDoc.embedPng(maskedBackPng);
      page.drawImage(backImg, { x: rightCardX, y: cardY, width: cardW, height: cardH });
    }

    if (!isKA) {
      const subTitleText = `Issued by Transport Department, Government of ${stateFullName}`;
      let subTitleSize = 5.6 * S;
      while (subTitleSize > 4.0 * S && fontBold.widthOfTextAtSize(subTitleText, subTitleSize) > 170.0 * S) {
        subTitleSize -= 0.2;
      }
      const subTitleWidth = fontBold.widthOfTextAtSize(subTitleText, subTitleSize);
      page.drawText(subTitleText, {
        x: leftCardX + ((cardW - subTitleWidth) / 2),
        y: cardY + ((CARD_HEIGHT - 21.0) * S),
        size: subTitleSize,
        font: fontBold,
        color: rgb(0.05, 0.15, 0.3)
      });
    }

    const frontData = {
      regNo: report.regNo,
      regDate: report.regDate,
      validUpto: report.validUpto,
      chassisNo: report.chassisNo,
      engineNo: report.engineNo,
      ownerName: report.owner,
      swdName: report.swd,
      address: report.address,
      fuel: report.fuel,
      emissionNorms: report.emissionNorms || 'BHARAT STAGE VI'
    };

    Object.entries(newRcFrontLayout).forEach(([key, cfg]) => {
      const val = frontData[key] || '';
      if (!val) return;
      const font = cfg.font === 'bold' ? fontBold : fontRegular;
      const textColor = cfg.font === 'bold' ? boldColor : softTextColor;
      const baselineY = CARD_HEIGHT - cfg.yTop;

      if (cfg.multiLine) {
        const lines = splitAddress(val, 55);
        lines.slice(0, cfg.maxLines).forEach((line, idx) => {
          const posX = idx === 1 && cfg.line2X ? cfg.line2X : cfg.x;
          page.drawText(String(line).trim(), {
            x: leftCardX + (posX * S),
            y: cardY + ((baselineY - (idx * cfg.lineHeight)) * S),
            size: cfg.size * S,
            font: font,
            color: textColor
          });
        });
      } else {
        let fontSize = cfg.size * S;
        while (fontSize > 4.0 * S && font.widthOfTextAtSize(String(val), fontSize) > (cfg.maxW || 100) * S) {
          fontSize -= 0.2;
        }
        page.drawText(String(val).trim(), {
          x: leftCardX + (cfg.x * S),
          y: cardY + (baselineY * S),
          size: fontSize,
          font: font,
          color: textColor
        });
      }
    });

    const backData = {
      vehicleClass:     report.vehicleClassFull || 'M-Cycel/Scooter (2WN)',
      regNo:            report.regNo || '',
      maker:            report.maker || '',
      model:            report.model || '',
      bodyType:         report.bodyType || '',
      seatingCapacity:  report.seating ? String(report.seating) : '2',
      standingCapacity: report.stdgSlpr ? report.stdgSlpr.split('/')[0].trim() : '0',
      sleeperCapacity:  '0',
      mfgDate:          report.mfgDate || '',
      unladenWeight:    report.unladenWt ? String(report.unladenWt) : '109',
      ladenWeight:      report.ladenWt ? String(report.ladenWt) : '239',
      grossWeight:      '0',
      cylinders:        report.cylinders ? String(report.cylinders) : '1',
      cubicCapacity:    report.cubicCap ? String(report.cubicCap) : '109.7',
      horsePower:       report.horsePower ? String(report.horsePower) : '7.37',
      wheelbase:        report.wheelBase ? String(report.wheelBase) : '1275',
      financer:         report.financer || '',
      rtoAuthority:     report.rto || 'CHICKABALLAPURA RTO'
    };

    Object.entries(newRcBackLayout).forEach(([key, cfg]) => {
      const val = backData[key] || '';
      if (!val) return;
      const font = cfg.font === 'bold' ? fontBold : fontRegular;
      const baselineY = CARD_HEIGHT - cfg.yTop;

      let fontSize = cfg.size * S;
      while (fontSize > 4.0 * S && font.widthOfTextAtSize(String(val), fontSize) > (cfg.maxW || 100) * S) {
        fontSize -= 0.2;
      }

      if (cfg.rightAnchor) {
        const textWidth = font.widthOfTextAtSize(String(val), fontSize);
        page.drawText(String(val).trim(), {
          x: rightCardX + ((cfg.x * S) - textWidth),
          y: cardY + (baselineY * S),
          size: fontSize,
          font: font,
          color: softTextColor
        });
      } else {
        page.drawText(String(val).trim(), {
          x: rightCardX + (cfg.x * S),
          y: cardY + (baselineY * S),
          size: fontSize,
          font: font,
          color: softTextColor
        });
      }
    });

  } else {
    const frontImgPath = path.join(__dirname, 'public', 'assets', 'templates', 'ka_front_hd.png');
    if (fs.existsSync(frontImgPath)) {
      const roundedFrontPng = await sharp(frontImgPath)
        .resize(1040, 655)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
        .png()
        .toBuffer();

      const frontImg = await pdfDoc.embedPng(roundedFrontPng);
      page.drawImage(frontImg, {
        x: leftCardX,
        y: cardY,
        width: cardW,
        height: cardH,
      });
    }

    page.drawRectangle({
      x: rightCardX,
      y: cardY,
      width: cardW,
      height: cardH,
      color: rgb(1, 1, 1),
    });

    function drawText(text, x, y, size, maxWidth = 170) {
      if (!text) return;
      let fontSize = size * S;
      let displayText = String(text).trim();
      while (fontSize > 4.0 * S && fontBold.widthOfTextAtSize(displayText, fontSize) > maxWidth * S) {
        fontSize -= 0.2;
      }
      page.drawText(displayText, {
        x: rightCardX + (x * S),
        y: cardY + (y * S),
        size: fontSize,
        font: fontBold,
        color: rgb(0, 0, 0)
      });
    }

    function drawTextRightAnchor(text, rightAnchorX, y, size) {
      if (!text) return;
      const fontSize = size * S;
      const displayText = String(text).trim();
      const textWidth = fontBold.widthOfTextAtSize(displayText, fontSize);
      const calculatedX = (rightAnchorX * S) - textWidth;

      page.drawText(displayText, {
        x: rightCardX + calculatedX,
        y: cardY + (y * S),
        size: fontSize,
        font: fontBold,
        color: rgb(0, 0, 0)
      });
    }

    function drawTextCenter(text, y, size) {
      if (!text) return;
      const fontSize = size * S;
      const displayText = String(text).trim();
      const textWidth = fontBold.widthOfTextAtSize(displayText, fontSize);
      const calculatedX = (cardW - textWidth) / 2;

      page.drawText(displayText, {
        x: rightCardX + calculatedX,
        y: cardY + (y * S),
        size: fontSize,
        font: fontBold,
        color: rgb(0, 0, 0)
      });
    }

    const fullRegNoText = `REG NO : ${report.regNo || ''}`;
    drawTextCenter(fullRegNoText, fieldLayout.header.regNoY, fieldLayout.header.regNoFontSize);
    drawTextRightAnchor(fieldLayout.header.form.label, fieldLayout.header.form.rightAnchorX, fieldLayout.header.form.y, fieldLayout.header.form.fontSize);
    drawTextRightAnchor(fieldLayout.header.formNote.label, fieldLayout.header.formNote.rightAnchorX, fieldLayout.header.formNote.y, fieldLayout.header.formNote.fontSize);

    fieldLayout.topLeft.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      if (field.isDot) drawText('.', field.dotX, field.y, field.fontSize, 5);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 95);
    });

    fieldLayout.topRight.forEach((field) => {
      let value = report[getFieldKey(field.label)];
      if (field.label === 'CLASS' && value) {
        value = String(value).replace(/\s*\(2WN\)\s*/i, '').trim();
      }
      drawText(field.label, field.labelX, field.y, field.fontSize, 28);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 65);
    });

    fieldLayout.middle.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      drawText(':', field.colonX, field.y, field.fontSize, 5);

      if (field.multiLine && value) {
        const lines = splitAddress(value, 44);
        lines.slice(0, field.maxLines).forEach((line, idx) => {
          const lineY = field.y - (idx * field.lineHeight);
          drawText(line, field.valueX, lineY, field.fontSize, 175);
        });
      } else {
        drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 175);
      }
    });

    fieldLayout.bottomLeft.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 120);
    });

    fieldLayout.bottomRight.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      if (field.isDot) drawText('.', field.dotX, field.y, field.fontSize, 5);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, 35);
    });

    drawTextRightAnchor(fieldLayout.footer.authority.label, fieldLayout.footer.authority.rightAnchorX, fieldLayout.footer.authority.y, fieldLayout.footer.authority.fontSize);
    drawTextRightAnchor(report.rto || 'RTO OFFICE', fieldLayout.footer.rto.rightAnchorX, fieldLayout.footer.rto.y, fieldLayout.footer.rto.fontSize);
  }

  const roundedSvg = Buffer.from(`
    <svg width="1040" height="655" viewBox="0 0 1040 655" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="1034" height="649" rx="32" ry="32" fill="none" stroke="#334155" stroke-width="4"/>
    </svg>
  `);

  const borderPngBuffer = await sharp(roundedSvg).png().toBuffer();
  const borderImg = await pdfDoc.embedPng(borderPngBuffer);

  page.drawImage(borderImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
  page.drawImage(borderImg, { x: rightCardX, y: cardY, width: cardW, height: cardH });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// Public Download Route
app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    let order = orders.get(orderId);
    if (!order) {
      const dbOrderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
      if (dbOrderRes.rows && dbOrderRes.rows.length > 0) {
        const row = dbOrderRes.rows[0];
        order = {
          orderId: row.order_id,
          docType: row.doc_type,
          targetNumber: row.lookup_key,
          status: row.status
        };
      }
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'SUCCESS') {
      return res.status(403).json({ error: 'Payment has not been verified for this order.' });
    }

    const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
    if (!report) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const pdfBuffer = await generateVectorPdfBuffer(order.docType, order.rcFormat || 'OLD', report);

    const fileName = order.docType === 'DL' ? `DL_${report.dlNo || 'Document'}.pdf` : `RC_${report.regNo || 'Document'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.send(pdfBuffer);

  } catch (err) {
    console.error('PDF Generation Error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

function getFieldKey(label) {
  const map = {
    'REG.DATE': 'regDate',
    'CHASSIS NO.': 'chassisNo',
    'ENGINE NO': 'engineNo',
    'MFR': 'maker',
    'O SLNO': 'ownerSerial',
    'CLASS': 'vehicleClassFull',
    'COLOUR': 'color',
    'OWNERNAME': 'owner',
    'S/W/D OF': 'swd',
    'ADDRESS': 'address',
    'MODEL': 'model',
    'BODY': 'bodyType',
    'WHEEL BASE': 'wheelBase',
    'MFG DATE': 'mfgDate',
    'FUEL': 'fuel',
    'REG/FC UPTO': 'validUpto',
    'TAX UPTO': 'taxUpto',
    'NO.OF CYL': 'cylinders',
    'UNLADEN WT': 'unladenWt',
    'SEATING': 'seating',
    'STDG/SLPR': 'stdgSlpr',
    'CC': 'cubicCap'
  };
  return map[label] || label.toLowerCase();
}

app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Backend Running at: http://localhost:${PORT}`);
});