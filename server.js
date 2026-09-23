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

// Raw body capture required for Auto Upi HMAC signature checking
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Serve admin.html from root
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
    address: '#1 KOLAR ROAD, VIJAYAPURA, , Bangalore Rural, KA, 562135',
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
  'KA09HJ1161': {
    regNo: 'KA09HJ1161',
    regDate: '06-07-2016',
    chassisNo: 'ME4JF505FGT539299',
    engineNo: 'JF50ET3541017',
    maker: 'HONDA MOTORCYCLE AND SCOOTER INDIA (P) LTD',
    model: 'H ACTIVA 3G CBS BS3',
    bodyType: 'U BONE',
    wheelBase: '0',
    mfgDate: '7 / 2016',
    fuel: 'PETROL',
    validUpto: '05-07-2031',
    taxUpto: 'LTT',
    owner: 'JYOTHI M',
    swd: 'NAGAVENI',
    address: '# 956, BEML LAYOUT, 2ND STAGE, RAJARAJESHWARI NAGAR, MYSORE, Karnataka, 570022',
    ownerSerial: '01',
    color: 'WHITE',
    vehicleClassFull: 'M-Cycle/Scooter',
    cylinders: '1',
    unladenWt: '108',
    seating: '2',
    stdgSlpr: '0 / 0',
    cubicCap: '109.00',
    rto: 'MYSORE WEST RTO',
    emissionNorms: 'BHARAT STAGE IV',
    financer: ''
  },
  'KA03HZ2486': {
    regNo: 'KA03HZ2486',
    regDate: '23-05-2015',
    chassisNo: 'MD2A11CZ3FWM15704',
    engineNo: 'DHZWFM93243',
    maker: 'BAJAJ AUTO LTD',
    model: 'PULSAR 150 DTS I (UG 4.5)',
    bodyType: 'SOLO WITH PI',
    wheelBase: '1320',
    mfgDate: '3 / 2015',
    fuel: 'PETROL',
    validUpto: '22-Apr-2030',
    taxUpto: 'LTT',
    owner: 'RAJU B',
    swd: 'BYATA VENKATAPPA',
    address: '# 20-A ULLITHIGALARA BEEDI,ANEKAL TOWN,BENGALURU WEF-2-2-16,Karnataka,562106',
    ownerSerial: '02',
    color: 'C WINE RED',
    vehicleClassFull: 'M-Cycle/Scooter',
    cylinders: '01',
    unladenWt: '143',
    seating: '02',
    stdgSlpr: '0 / 0',
    cubicCap: '149.00',
    rto: 'BENGALURU WEST RTO',
    emissionNorms: 'BHARAT STAGE III',
    financer: ''
  },
  'KA40Y5748': {
    regNo: 'KA40Y5748',
    regDate: '12-08-2020',
    chassisNo: 'MD625CF10G1A92643',
    engineNo: 'CF1AG1427521',
    maker: 'TVS MOTOR COMPANY LTD',
    model: 'TVS STAR CITY ES MAG',
    bodyType: 'SOLO WITH PI',
    wheelBase: '1250',
    mfgDate: '1 / 2016',
    fuel: 'PETROL',
    validUpto: '25-May-2031',
    taxUpto: 'LTT',
    owner: 'RAJAPPA',
    swd: 'NARASIMHAIAH',
    address: '186 GERATIGINBELE, ANEKAL TALUK, BANGALORE, Karnataka, 562106',
    ownerSerial: '01',
    color: 'RED',
    vehicleClassFull: 'M-Cycle/Scooter',
    cylinders: '01',
    unladenWt: '108',
    seating: '02',
    stdgSlpr: '0 / 0',
    cubicCap: '109.70',
    rto: 'CHANDAPURA, BENGALURU RTO',
    emissionNorms: 'BHARAT STAGE VI',
    financer: 'HDFC BANK LTD'
  },
  'TN01AB1234': {
    regNo: 'TN01AB1234',
    regDate: '15-08-2022',
    chassisNo: 'ME1RG0812NA019283',
    engineNo: 'G3J4E0918231',
    maker: 'INDIA YAMAHA MOTOR PVT LTD',
    model: 'YZF R15 V4',
    bodyType: '2 WHEELER',
    wheelBase: '1325',
    mfgDate: '07/2022',
    fuel: 'PETROL',
    validUpto: '14-08-2037',
    taxUpto: 'LTT',
    owner: 'KARTHIK RAJAN',
    swd: 'MUTHUVEL RAJAN',
    address: 'NO 42, ANNA SALAI, T NAGAR, CHENNAI, Tamil Nadu, 600017',
    ownerSerial: '01',
    color: 'RACING BLUE',
    vehicleClassFull: 'M-Cycel/Scooter (2WN)',
    cylinders: '1',
    unladenWt: '142',
    ladenWt: '290',
    horsePower: '18.40',
    seating: '2',
    stdgSlpr: '0 / 0',
    cubicCap: '155.0',
    rto: 'CHENNAI CENTRAL RTO',
    emissionNorms: 'BHARAT STAGE VI',
    financer: 'HDFC BANK LTD'
  },
  'MH02CB5566': {
    regNo: 'MH02CB5566',
    regDate: '10-01-2023',
    chassisNo: 'MA3EAA11S00192834',
    engineNo: 'K12MN9823412',
    maker: 'MARUTI SUZUKI INDIA LTD',
    model: 'TOUR S (CNG)',
    bodyType: 'SEDAN',
    wheelBase: '2450',
    mfgDate: '12/2022',
    fuel: 'CNG/PETROL',
    validUpto: '09-01-2025',
    taxUpto: 'ANNUAL',
    owner: 'AMIT PRAKASH JADHAV',
    swd: 'PRAKASH JADHAV',
    address: 'FLAT 304, SHIVAM APTS, ANDHERI WEST, MUMBAI, Maharashtra, 400058',
    ownerSerial: '01',
    color: 'SUPERIOR WHITE',
    vehicleClassFull: 'Motor Cab / Commercial Taxi',
    cylinders: '4',
    unladenWt: '1010',
    ladenWt: '1480',
    horsePower: '67.0',
    seating: '5',
    stdgSlpr: '0 / 0',
    cubicCap: '1197.0',
    rto: 'ANDHERI RTO (MH02)',
    emissionNorms: 'BHARAT STAGE VI',
    financer: 'STATE BANK OF INDIA'
  },
  'DL1CAB9988': {
    regNo: 'DL1CAB9988',
    regDate: '20-03-2021',
    chassisNo: 'MALC181CLMM091823',
    engineNo: 'G4FLM8912301',
    maker: 'HYUNDAI MOTOR INDIA LTD',
    model: 'CRETA 1.5 SX',
    bodyType: 'SUV',
    wheelBase: '2610',
    mfgDate: '02/2021',
    fuel: 'PETROL',
    validUpto: '19-03-2036',
    taxUpto: 'OTT',
    owner: 'ROHIT VERMA',
    swd: 'SURESH VERMA',
    address: 'C-12, CONNAUGHT PLACE, NEW DELHI, Delhi, 110001',
    ownerSerial: '01',
    color: 'POLAR WHITE',
    vehicleClassFull: 'Motor Car (LMV)',
    cylinders: '4',
    unladenWt: '1215',
    ladenWt: '1690',
    horsePower: '113.4',
    seating: '5',
    stdgSlpr: '0 / 0',
    cubicCap: '1497.0',
    rto: 'MALL ROAD, DELHI RTO',
    emissionNorms: 'BHARAT STAGE VI',
    financer: 'ICICI BANK LTD'
  },
  'KL07BW4321': {
    regNo: 'KL07BW4321',
    regDate: '11-11-2022',
    chassisNo: 'MAT491029N9102834',
    engineNo: 'E2718293041',
    maker: 'TATA MOTORS LTD',
    model: 'TATA ACE GOLD',
    bodyType: 'OPEN GOODS VEHICLE',
    wheelBase: '2100',
    mfgDate: '10/2022',
    fuel: 'DIESEL',
    validUpto: '10-11-2024',
    taxUpto: 'QUARTERLY',
    owner: 'MANOJ KURIAN',
    swd: 'KURIAN JOSEPH',
    address: 'HOUSE NO 14, MG ROAD, ERNAKULAM, KOCHI, Kerala, 682016',
    ownerSerial: '01',
    color: 'ARCTIC WHITE',
    vehicleClassFull: 'Goods Carrier / Commercial Transport',
    cylinders: '2',
    unladenWt: '875',
    ladenWt: '1675',
    horsePower: '20.0',
    seating: '2',
    stdgSlpr: '0 / 0',
    cubicCap: '702.0',
    rto: 'ERNAKULAM RTO (KL07)',
    emissionNorms: 'BHARAT STAGE VI',
    financer: 'KOTAK MAHINDRA BANK'
  },
  'KA1320170004921': {
    dlNo: 'KA13 20170004921',
    doi: '05-05-2017',
    validUptoNT: '04-05-2037',
    validUptoTR: '',
    name: 'HARISHAKUMARA C',
    dob: '24-04-1993',
    bloodGroup: '',
    organDonor: 'N',
    swd: 'DHARMEGOWDA',
    address: '#1 KOLAR ROAD, VIJAYAPURA, , Bangalore Rural, KA, 562135',
    firstIssueDate: '02-07-2026',
    adpVehNo: '',
    hazardousValidity: '',
    hillValidity: '',
    covList: [
      { covType: 'CAR', code: 'LMV', issuedBy: 'KA51', doi: '18-05-2013', category: 'NT', badgeNo: '', badgeDoi: '', badgeBy: '' }
    ],
    mobileNo: '',
    rtoAuthority: 'RTO, HASSAN'
  },
  'KA1120140002551': {
    dlNo: 'KA11 20140002551',
    doi: '23-08-2022',
    validUptoNT: '08-06-2035',
    validUptoTR: '',
    name: 'PAVAN KUMAR K',
    dob: '09-06-1995',
    bloodGroup: 'B+VE',
    organDonor: 'N',
    swd: 'KALASAIAH',
    address: 'Javarayyana Beedi Kurupete Kanakapura, Kanakapura Ramanagar Karnataka 562117',
    firstIssueDate: '12-04-2014',
    adpVehNo: '',
    hazardousValidity: '',
    hillValidity: '',
    covList: [
      { covType: 'BIKE', code: 'MCWG', issuedBy: 'KA11', doi: '12-04-2014', category: 'NT', badgeNo: '', badgeDoi: '', badgeBy: '' },
      { covType: 'CAR', code: 'LMV', issuedBy: 'KA42', doi: '23-08-2022', category: 'NT', badgeNo: '', badgeDoi: '', badgeBy: '' }
    ],
    mobileNo: '',
    rtoAuthority: 'RAMANAGARA-(KA42)'
  }
};

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
// LIVE SUREPASS DATA RESOLVER WITH POSTGRESQL CACHING & ENRICHMENT
// =====================================================================
async function getVehicleOrDlRecord(docType, rawTargetNumber, dob) {
  const lookupKey = String(rawTargetNumber || '').replace(/[^A-Z0-9]/g, '').toUpperCase();

  // 1. Static mock check
  if (mockDatabase[lookupKey]) {
    return mockDatabase[lookupKey];
  }

  // 2. PostgreSQL Cache Check
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

  // 3. Surepass Live Call
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
        regDate: d.registration_date || '',
        chassisNo: d.chassis_number || d.vehicle_chasi_number || '',
        engineNo: d.engine_number || d.vehicle_engine_number || '',
        maker: d.maker_description || d.maker_model || '',
        model: d.maker_model || '',
        bodyType: d.body_type || 'SEDAN',
        wheelBase: String(d.wheelbase || '0'),
        mfgDate: d.manufacturing_date || '',
        fuel: String(d.fuel_type || 'PETROL').toUpperCase(),
        validUpto: d.fit_up_to || d.fitness_upto || '',
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

      try {
        await pool.query(
          `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (lookup_key) DO UPDATE 
           SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
          [docType, lookupKey, JSON.stringify(formattedRc)]
        );
      } catch (cacheErr) {
        console.warn('[PostgreSQL Cache Write Warning]:', cacheErr.message);
      }

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
      const formattedDl = {
        dlNo: d.license_number || lookupKey,
        doi: d.issue_date || '',
        validUptoNT: d.nt_validity_to || (d.validity && d.validity.non_transport) || '',
        validUptoTR: d.tr_validity_to || (d.validity && d.validity.transport) || '',
        name: d.name || '',
        dob: d.dob || cleanDob || '',
        bloodGroup: d.blood_group || '',
        organDonor: 'N',
        swd: d.father_or_husband_name || '',
        address: d.permanent_address || d.present_address || '',
        firstIssueDate: d.first_issue_date || d.issue_date || '02-07-2026',
        adpVehNo: '',
        hazardousValidity: '',
        hillValidity: '',
        covList: (d.cov_details || []).map(c => ({
          covType: 'VEHICLE',
          code: c.class_of_vehicle || 'LMV',
          issuedBy: c.issue_authority || '',
          doi: c.issue_date || '',
          category: c.vehicle_category || 'NT',
          badgeNo: '',
          badgeDoi: '',
          badgeBy: ''
        })),
        mobileNo: '',
        rtoAuthority: d.issuing_authority || 'RTO OFFICE'
      };

      try {
        await pool.query(
          `INSERT INTO documents_cache (doc_type, lookup_key, raw_data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (lookup_key) DO UPDATE 
           SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
          [docType, lookupKey, JSON.stringify(formattedDl)]
        );
      } catch (cacheErr) {
        console.warn('[PostgreSQL Cache Write Warning]:', cacheErr.message);
      }

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
// CUSTOMER AUTHENTICATION VIA MSG91 OTP WIDGET (HEADLESS)
// =====================================================================
app.post('/api/customer/send-otp', async (req, res) => {
  const { mobile } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');

  if (cleanMobile.length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  // Developer Bypass for testing/audits without spending SMS credits
  if (cleanMobile === '9999999999' || cleanMobile === '1234567890') {
    otpStore.set(cleanMobile, { reqId: 'DEV_TEST', expiresAt: Date.now() + 5 * 60 * 1000 });
    console.log(`[DEV TEST OTP] Mobile: ${cleanMobile} -> Use OTP '1234'`);
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
    console.log(`[MSG91 Send OTP Response] Mobile: ${cleanMobile}:`, JSON.stringify(data));

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

  // 1. Audit / Developer Bypass
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
    console.log(`[MSG91 Verify Response] Mobile: ${cleanMobile}:`, JSON.stringify(data));

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
// AGENT ROUTES (DATABASE BACKED)
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

// Helper function to check role from headers
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
// DEDICATED ADMIN MANAGEMENT & REAL-TIME ANALYTICS ROUTES
// =====================================================================
app.post('/api/admin/login', (req, res) => {
  const { secretKey } = req.body;
  if (ADMIN_MASTER_SECRET && secretKey === ADMIN_MASTER_SECRET) {
    return res.json({ success: true, token: ADMIN_SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid Admin Master Secret Key' });
});

// Admin Live Metrics
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

// Admin All Orders List
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

// Admin Agent Roster (From DB)
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

// Admin Agent Status Update (Approve / Reject into DB)
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

// Admin ₹0 Direct Download Tool
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

    // Record this in orders as Admin Free Download
    const adminOrderId = 'ADM_' + Date.now();
    await pool.query(
      `INSERT INTO orders (order_id, user_phone, doc_type, lookup_key, amount, status, utr, created_at, paid_at)
       VALUES ($1, 'ADMIN', $2, $3, 0, 'SUCCESS', 'ADMIN_DIRECT', NOW(), NOW())`,
      [adminOrderId, docType, targetNumber]
    ).catch(() => {});

    // Generate Vector PDF
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
// ORDER PROCESSING & AUTO UPI INTEGRATION
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

    // Connect to Auto Upi API
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
        console.log('[Auto Upi Create Order Response]:', JSON.stringify(data));

        if (data.ok === true) {
          gatewayOrderId = data.order_id;
          localOrderId = data.order_id;
          payableAmount = data.payable_amount || finalAmount;
          paymentUrl = data.payment_url;
        } else {
          console.warn('[Auto Upi Warning] Order creation returned:', data.error || data);
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

// =====================================================================
// PAYMENT VERIFICATION
// =====================================================================
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
      console.log(`[Auto Upi Status Check] Order: ${orderId}, Result:`, JSON.stringify(checkData));

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

// =====================================================================
// AUTOMATED AUTO UPI WEBHOOK
// =====================================================================
app.post('/api/bank-webhook', (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signatureHeader = req.headers['x-autoupi-signature'] || '';
    const payload = req.body || {};

    console.log('📥 [Auto Upi Webhook Received]:', JSON.stringify(payload));

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
            console.warn('⚠️ [Webhook Security] Invalid Auto Upi signature rejected');
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

        console.log(`🚀 [WEBHOOK SUCCESS] Order ${targetId} marked PAID! Amount: ₹${amount}`);
      }
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Auto Upi Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Manual Unlock Route
app.post('/api/mark-paid', (req, res) => {
  const { orderId } = req.body;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'Invalid Order ID' });

  order.status = 'SUCCESS';
  order.paidAt = new Date();
  order.paymentId = 'MANUAL_' + Date.now();

  pool.query('UPDATE orders SET status = $1, paid_at = NOW(), utr = $2 WHERE order_id = $3', [
    'SUCCESS',
    order.paymentId,
    orderId
  ]).catch(() => {});

  res.json({ success: true, message: `Order ${orderId} unlocked.` });
});

// =====================================================================
// VECTOR PDF BUILDER FUNCTION (REUSED FOR PUBLIC & ADMIN DOWNLOADS)
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

  function splitAddress(addr, maxChars = 55) {
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

    const b2FWidth = fontRegular.widthOfTextAtSize(stateCode, 5.2 * S);
    page.drawText(stateCode, {
      x: leftCardX + (232.0 * S) - (b2FWidth / 2),
      y: cardY + ((CARD_HEIGHT - 14.5) * S),
      size: 5.2 * S,
      font: fontRegular,
      color: rgb(0, 0, 0)
    });

    const cleanDlNo = String(report.dlNo || '').trim();
    page.drawText(cleanDlNo, {
      x: leftCardX + (89.0 * S),
      y: cardY + ((CARD_HEIGHT - 35.5) * S),
      size: 8.5 * S,
      font: fontBold,
      color: boldColor
    });

    page.drawText(String(report.doi || '').trim(), {
      x: leftCardX + (57.0 * S),
      y: cardY + ((CARD_HEIGHT - 59.5) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    page.drawText(String(report.validUptoNT || '').trim(), {
      x: leftCardX + (101.0 * S),
      y: cardY + ((CARD_HEIGHT - 59.5) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    if (report.validUptoTR) {
      page.drawText(String(report.validUptoTR).trim(), {
        x: leftCardX + (152.0 * S),
        y: cardY + ((CARD_HEIGHT - 59.5) * S),
        size: 6.5 * S,
        font: fontRegular,
        color: softTextColor
      });
    }

    page.drawText(String(report.name || '').trim(), {
      x: leftCardX + (28.0 * S),
      y: cardY + ((CARD_HEIGHT - 92.0) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    page.drawText(String(report.dob || '').trim(), {
      x: leftCardX + (47.0 * S),
      y: cardY + ((CARD_HEIGHT - 111.2) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    page.drawText(String(report.bloodGroup || '').trim(), {
      x: leftCardX + (148.0 * S),
      y: cardY + ((CARD_HEIGHT - 111.2) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    page.drawText(String(report.organDonor || 'N').trim(), {
      x: leftCardX + (222.0 * S),
      y: cardY + ((CARD_HEIGHT - 111.2) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });
    page.drawText(String(report.swd || '').trim(), {
      x: leftCardX + (79.0 * S),
      y: cardY + ((CARD_HEIGHT - 122.5) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });

    const dlAddrLines = splitAddress(report.address || '', 55);
    dlAddrLines.slice(0, 2).forEach((line, idx) => {
      page.drawText(String(line).trim(), {
        x: leftCardX + (35.0 * S),
        y: cardY + ((CARD_HEIGHT - (136.0 + (idx * 6.8))) * S),
        size: 6.0 * S,
        font: fontRegular,
        color: softTextColor
      });
    });

    page.drawText(`( ${report.firstIssueDate || '02-07-2026'} )`, {
      x: leftCardX + (238.5 * S),
      y: cardY + (72.0 * S),
      size: 5.0 * S,
      font: fontRegular,
      color: softTextColor,
      rotate: { type: 'degrees', angle: 90 }
    });

    page.drawText(cleanDlNo, {
      x: rightCardX + (32.0 * S),
      y: cardY + ((CARD_HEIGHT - 9.0) * S),
      size: 7.0 * S,
      font: fontBold,
      color: boldColor
    });

    if (report.covList && Array.isArray(report.covList)) {
      report.covList.slice(0, 5).forEach((cov, idx) => {
        const rowY = 83.8 + (idx * 11.5);
        const codeVal = String(cov.code || '').trim();
        const codeW = fontRegular.widthOfTextAtSize(codeVal, 5.8 * S);
        page.drawText(codeVal, {
          x: rightCardX + (49.0 * S) - (codeW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 5.8 * S,
          font: fontRegular,
          color: softTextColor
        });

        const issuedVal = String(cov.issuedBy || '').trim();
        const issuedW = fontRegular.widthOfTextAtSize(issuedVal, 5.8 * S);
        page.drawText(issuedVal, {
          x: rightCardX + (73.0 * S) - (issuedW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 5.8 * S,
          font: fontRegular,
          color: softTextColor
        });

        const doiVal = String(cov.doi || '').trim();
        const doiW = fontRegular.widthOfTextAtSize(doiVal, 4.8 * S);
        page.drawText(doiVal, {
          x: rightCardX + (108.0 * S) - (doiW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 4.8 * S,
          font: fontRegular,
          color: softTextColor
        });

        const catVal = String(cov.category || 'NT').trim();
        const catW = fontRegular.widthOfTextAtSize(catVal, 5.8 * S);
        page.drawText(catVal, {
          x: rightCardX + (144.0 * S) - (catW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 5.8 * S,
          font: fontRegular,
          color: softTextColor
        });
      });
    }

    if (report.mobileNo) {
      page.drawText(String(report.mobileNo).trim(), {
        x: rightCardX + (46.0 * S),
        y: cardY + ((CARD_HEIGHT - 146.0) * S),
        size: 6.0 * S,
        font: fontRegular,
        color: softTextColor
      });
    }

    const rtoVal = String(report.rtoAuthority || 'RTO, HASSAN').trim();
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

      const b1FWidth = fontRegular.widthOfTextAtSize(vehicleBadge, 5.2 * S);
      page.drawText(vehicleBadge, {
        x: leftCardX + (218.0 * S) - (b1FWidth / 2),
        y: cardY + ((CARD_HEIGHT - 14.5) * S),
        size: 5.2 * S,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });

      const b2FWidth = fontRegular.widthOfTextAtSize(stateCode, 5.2 * S);
      page.drawText(stateCode, {
        x: leftCardX + (232.0 * S) - (b2FWidth / 2),
        y: cardY + ((CARD_HEIGHT - 14.5) * S),
        size: 5.2 * S,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });

      const b1BWidth = fontRegular.widthOfTextAtSize(vehicleBadge, 5.2 * S);
      page.drawText(vehicleBadge, {
        x: rightCardX + (9.5 * S) - (b1BWidth / 2),
        y: cardY + ((CARD_HEIGHT - 12.5) * S),
        size: 5.2 * S,
        font: fontRegular,
        color: rgb(0, 0, 0)
      });

      const b2BWidth = fontRegular.widthOfTextAtSize(stateCode, 5.2 * S);
      page.drawText(stateCode, {
        x: rightCardX + (24.0 * S) - (b2BWidth / 2),
        y: cardY + ((CARD_HEIGHT - 12.5) * S),
        size: 5.2 * S,
        font: fontRegular,
        color: rgb(0, 0, 0)
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