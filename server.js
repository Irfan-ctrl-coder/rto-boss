require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const { rateLimit } = require('express-rate-limit');
const pincodeLookup = require('india-pincode-lookup');

const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Nginx on VPS) for accurate IP resolution in rate limiting
app.set('trust proxy', 1);

// PostgreSQL Connection Setup
const DATABASE_URL = process.env.DATABASE_URL;

if (process.env.NODE_ENV === 'production' && !DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured in production.');
}

const pool = new Pool({
  connectionString: DATABASE_URL || 'postgresql://rtoboss_user:CHANGE_ME@localhost:5432/rtoboss_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Error]:', err.message);
});

const ADMIN_MASTER_SECRET = process.env.ADMIN_MASTER_SECRET;
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN || crypto.randomBytes(32).toString('hex');

// =====================================================================
// RAZORPAY PRODUCTION GATEWAY CONFIG
// =====================================================================
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

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
const MSG91_TOKEN_AUTH = process.env.MSG91_TOKEN_AUTH || '';

if (process.env.NODE_ENV === 'production') {
  if (!ADMIN_MASTER_SECRET) {
    throw new Error('ADMIN_MASTER_SECRET must be configured in production.');
  }
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured in production.');
  }
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured in production.');
  }
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

// =====================================================================
// RATE LIMITING PROTECTION TIERS
// =====================================================================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' }
});
app.use('/api/', generalLimiter);

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification code attempts from this connection. Please wait 10 minutes.' }
});

const orderLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many order requests. Please slow down.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many admin login attempts. Please try again later.' }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// =====================================================================
// IN-MEMORY STORES
// =====================================================================
const orders = new Map();
const otpStore = new Map();
const customers = new Map();

// =====================================================================
// ALL-INDIA STATE MASTER MAPPING
// =====================================================================
const STATE_NAMES = {
  AN: 'ANDAMAN AND NICOBAR', AP: 'ANDHRA PRADESH', AR: 'ARUNACHAL PRADESH', AS: 'ASSAM',
  BR: 'BIHAR', CG: 'CHHATTISGARH', CH: 'CHANDIGARH', DD: 'DAMAN AND DIU', DL: 'DELHI',
  DN: 'DADRA AND NAGAR HAVELI', GA: 'GOA', GJ: 'GUJARAT', HP: 'HIMACHAL PRADESH', HR: 'HARYANA',
  JH: 'JHARKHAND', JK: 'JAMMU AND KASHMIR', KA: 'KARNATAKA', KL: 'KERALA', LA: 'LADAKH',
  LD: 'LAKSHADWEEP', MH: 'MAHARASHTRA', ML: 'MEGHALAYA', MN: 'MANIPUR', MP: 'MADHYA PRADESH',
  MZ: 'MIZORAM', NL: 'NAGALAND', OD: 'ODISHA', PB: 'PUNJAB', PY: 'PUDUCHERRY', RJ: 'RAJASTHAN',
  SK: 'SIKKIM', TN: 'TAMIL NADU', TR: 'TRIPURA', TS: 'TELANGANA', UK: 'UTTARAKHAND', UP: 'UTTAR PRADESH', WB: 'WEST BENGAL'
};

// =====================================================================
// CLEAN VECTOR SILHOUETTE SVGs
// =====================================================================
const SVG_ICONS = {
  CAR: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAE4UlEQVR4nN1WfSz9VRi/12so7y95f5kmc41oslgoRWuN0RLuJPI214ShxdBkZMLSuFJiPy4m08yEqKwsRhgWY5WoXC8hrnfubZ+ts53f173ce3+/1Prjs3vPc57zfD/nc855noclkUhY/2Ww/vcExWIxm2nb3d3VFwqFZsD6+vrDR0dHWv+6gouLi07Nzc0xRUVFhYmJifWxsbGfREVFtYaHh3+akZFRWVZWltvT0/Pi1taW8a0rKBAIIv39/b8KDAz8Ii4u7uOwsLAudXX1My8vr/Hk5OQ6Lpd7Jzg4+HNTU9MNEIayt0awoaHhdTMzM2FxcXH+xsaGKWxLS0uPmJiYbHZ2dr6E8fn5uRqUw9je3v6n+Pj4j6RdjftOUCAQRNra2q5UVFRkXVxcqBL7xMTE40ZGRtsjIyNPMdcMDQ094+Dg8GNtbW3KP0qwq6srzNzc/HeQY8719fU9r6ur++fk5KSntLWNjY2v2dnZ/Tw9Pe0uN0FILq/sCMzhcOZw+aWtaW1tjdLT09tbWFh4VNp6qB0ZGSmIjo5u2d/ff0ghgteRPD4+fmB0dPRJXH5c9oODgwcPDw+18UtwenqqAVWNjY235ufnXZBi6Hng5OREE+paWVmtxcTENHd0dLwMDA8PP315eaki84hlEVxbW7Nqa2t7BYo5Ojous1gsCV5qTk7Ou6mpqR8APB6vBsjKyqrw8/P7WkdHR4RUk56eXk3miG9aWtr7sFtYWPyGWAQYY1Ny3UEo09/fH5SXl/dOUFBQv4GBwQ4dTE1N7ZzNZotvgoqKyqUsO4lBx21paYm+liAyf2FhYVFAQMCXzB0CCAyQMZvxAQJVVdULaXamD9kAseEBySR4dnamDvk1NDROZREjQcl/9t+K0L5EIXoj0sBUFLbq6up0mQRxcbW1tQ/pIKgI0gLSQVlSwDxa5jyJS/yI4tnZ2eUyCeL10cfm5uY2AxtUpYnLOlbWDWrhV1NT8wTlD3E9PT0nmfM+Pj7f7u3t6ZFHe1duCg0N7SYLkO1R/FHK8IKxM7JLRQmyKbVTUlJq29vbI+rr6xObmppedXZ2/oGOqaWldTQwMPDcFYLb29tGHh4e3xPnzMzM95KSkvgYI6fV1NTw3N3dp8mxKKMeh8OZ4/P5SahAGKOJKCgoeJv2hcK9vb0vXCGIjO7r6/sNnJBSysvLsw0NDf8gC5H3CGFlweVy76B6kLG+vv5uaWnpm+hyiA01fHZ21vUKQSAkJOQzOCEZ5+bmltHBXV1dZ5ET74Ugj8eroe8dgIRNjhlAyyYSiXSkPpKSkpK3rK2tV5GY0RLRgWBHS4VjBlkcF4fDmcN/JyenRZQt+EgD5tAcoMrY2Nj8QsdNSEj4EMK4uLjMR0REtA8ODj5LV7a7CII5Sg36OfKiCSwtLX9dXl523NzcNCHtvFAoNMN4ZWXFdmxs7Inx8XEvWZiamnoMPugH6bj5+fnFq6ur1igQeL10Lb5CkAYKN50DUV/ReMrT7UhkAOtxhPTj6e7uDpWrm2FiZ2fHgAQD0bq6umR6Z8qS5PP5SWTj3t7e3yF7KEUQmJmZcUOSrqyszKAv7r1AJBLpVFVVvYFkjc77Jv8bA6K/o5VTVj0xYy16S3nWXRtQEbtEQYLy4sag0sb3g6RYTsK3TlCi4Gko/JHbxl+QvfplZc+fyAAAAABJRU5ErkJggg==', 'base64'),
  BIKE: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAFKElEQVR4nO1XaUh0ZRi9Tu77mvuK5pZouEuau+DnbpZO4FJaiCu5kpmaSrmRG6GlXwqaW2maQaZOlrgWGrknLqnlmmaauc6NA14YBrVxwE9/9ONh7rzz8j7nPuc853mHIEmSeMhB3DcA8n+AJEkwmUwefJ6envL19PQ4JSYmFkRGRn5YXFwct7OzI/NgAM7OzuoaGBhMEQRBInh4eJgJCQmFR0dHQg+C4u3tbVkHBwcGBRCho6Pzy+TkpOGDAHhycsIfHh7+MYDx8vKeaWlpLdja2n4/Pj5uQlWaqvYTp5h5mXhiYuLZuLi4Yg8Pjy+zs7PfHhwctAZwdjncSwXJyxgdHTW3t7f/VlRU9ACUQ5v3RvH5+flTBwcHotT37u5uZ319/WlWHRYVFb35xAEeHx8L1NbWBtPp9Hp3d/evYmNjS9LT099VUlL6jZ+f/0RAQOCYAujk5NTD+hJ3BpDBYDjU1NSEAFx9fT1dQUFh3dfXt9XR0bFXXV19WVJScs/c3Hy0paXlxYCAgGYKoKys7Pbw8LDlnQPMysp6R0pKare5uTkA2qLT6fV7e3uS+/v74ktLSxpDQ0NWCwsLWtjb3t7uJSgo+A8A0mi0i9zc3LfuHGBhYWECAJaUlMSicgwGw+E6PywoKEgUERE5pKro5ub2NTeGzfHGjY0N+by8vGRTU9MfXVxcvtHV1Z2F57GOsoGBARusWVhYjIiLi+9T4ISEhI7S0tJycAb25OfnJ4WGhn7S2trqe3FxQeMKIPxqbW1NuauryzUjIyPT2dm5G1oSFhb+m0pMY6EONLNPEW1t7Xk7O7vv4InYh6pDp6isjIzMDtbn5uae4QogEkZHR5fJy8tviImJ/cXHx3fKmhzgCIIgkRCUd3R0eGpqai5i3dLScjg4OLjW09OzAwDRQDjDx8enraGhIRA+ubi4qAm9bm5uPn1rgKge3H9qaspgbGzsOczS3t5ex6SkpHw1NbVfqYsA7RIk5q23t/cXEhISf5qZmf3g5eXVDglQNOO5srLydVAKgLCntrY2H1DOlQZZx9H8/Lx2U1PTSzgYz319fS8YGhpOUiAJgiBhLdbW1oN49vf3/wzUUZVWVVVdqaqqeg1XMFZdIjBtRkZGLLiiGPYRHx//gaKi4u8aGhpLSAQKy8rKouFzoIy4TAQaQSsq6ufn9zmahJJBamrqezExMaVUtREw9sbGxpdBvZGR0c+g/FYA0VmZmZkZABEVFVU+MzOjh8DdTkVFZTU5OTkPoIjLhACnp6c3A72iepReIQd0LyoeEhJSA7DS0tJ/wIKQB79hH87DyOQYILrX2Nj4J9DFagNnZ2e8ED40lZKS8j4up5i7sJ2cnJw0dDsAYh2A0Si4WWP89ff3P48JBKCYMvhE9QAwKCj0+tG4ZUA0RRIjKTsv4F2UDM9Pa2PF1lZWVFdXl5WB3gEuhNrCHgkJIHKRkREfARqUXlcx1hnNV4E4DkGuL6+rgAdYcZubW3JsZq1jY3NACi97kCSLSANExOTcQqMq6tr1+HhoUhpaWkMPBXaxH+XWzdJdXX1q+g6WAYsBoEGgO/BJtg7nnnDbbm8vDyKqhgmESwnLCzsMdYCAwMbbrKbawFCe7ixWFlZDSkrK68hUNW6urpXrhpPzBtuyvi3V1FR8Qau/3JyclvwS2gU17Pd3V0prmyGtWFgsDBWaI0TWslrYnV1VaWzs/MRbApDgJPrP9fJ/otWkoPKchK3AnNbcCTbvqvOuLMKcgOQm+r+CyPMKH0M6YVrAAAAAElFTkSuQmCC', 'base64')
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
  'KA0120110006162': {
    dlNo: 'KA01 20110006162',
    doi: '10-06-2011',
    validUptoNT: '09-06-2031',
    validUptoTR: '',
    name: 'MAMATHA H S',
    dob: '17-03-1992',
    bloodGroup: '',
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
    firstIssueDate: '18-05-2013',
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

// Deterministic Address Generator — Expanded 25+ Location Patterns, balanced for ~40 char wrap
function enrichAddress(rawAddress, rtoAuthority, regNo) {
  const addrStr = String(rawAddress || '').replace(/^[\s,]+/, '').trim();
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

function findCustomerByToken(token) {
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
    const customer = findCustomerByToken(token);
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
        ADD COLUMN IF NOT EXISTS rc_format TEXT
    `);
    console.log('[Security] Orders security schema verified.');
  } catch (err) {
    console.error('[Security] Orders schema migration warning:', err.message);
  }
})();

async function generateSignaturePng(fullName) {
  const seedStr = String(fullName || 'Driver');
  const seed = seedStr.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const style = seed % 4;

  let pathData = '';
  if (style === 0) {
    // Cursive looped flow
    pathData = `M 22 28 C 25 15, 35 8, 42 18 C 50 28, 42 35, 52 24 C 60 16, 70 18, 78 22 C 86 26, 95 15, 105 22 C 115 29, 122 18, 132 20 C 142 22, 150 16, 165 22 M 26 31 C 70 35, 120 32, 172 28`;
  } else if (style === 1) {
    // Initial heavy and sharp peaks
    pathData = `M 20 25 C 28 8, 38 32, 45 15 C 52 2, 60 22, 70 20 C 85 18, 95 28, 110 21 C 125 14, 140 24, 168 21 M 25 33 C 75 36, 125 33, 170 30`;
  } else if (style === 2) {
    // Angular zig-zag scribble
    pathData = `M 22 22 L 35 12 L 48 26 L 62 15 L 75 28 L 92 18 C 110 15, 125 25, 145 20 C 155 18, 162 22, 172 21 M 24 32 C 70 35, 120 33, 170 29`;
  } else {
    // Compact wave
    pathData = `M 24 26 C 30 18, 38 15, 45 22 C 52 29, 60 18, 70 21 C 82 24, 92 17, 105 22 C 120 27, 135 19, 168 21 M 28 33 C 70 35, 120 32, 172 30`;
  }

  const svg = `
    <svg width="220" height="45" viewBox="0 0 220 45" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-2 110 22)">
        <path d="${pathData}" fill="none" stroke="#050c1a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
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
      console.log(`[Cache Hit] Serving ${lookupKey} directly from PostgreSQL.`);
      const cached = dbRes.rows[0].raw_data;
      if (cached && cached.address) {
        cached.address = enrichAddress(cached.address, cached.rto || cached.rtoAuthority, lookupKey);
      }
      return cached;
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
      let resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/rc/rc-v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
        },
        body: JSON.stringify({ id_number: lookupKey, enrich: true })
      });

      let json = await resp.json();

      if (json && json.status_code === 500 && json.message && json.message.includes('Timed Out')) {
        console.warn(`[Upstream Timeout] Retrying RC ${lookupKey} in 1.2 seconds...`);
        await new Promise(res => setTimeout(res, 1200));
        resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/rc/rc-v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
          },
          body: JSON.stringify({ id_number: lookupKey, enrich: false })
        });
        json = await resp.json();
      }

      if (!resp.ok || !json.success || !json.data) {
        console.error('[Surepass RC Failed]:', json);
        return null;
      }

      const d = json.data;
      let normalizedBody = String(d.body_type || 'SEDAN').trim();
      if (/SOLO/i.test(normalizedBody)) normalizedBody = 'SOLO';

      let normalizedColor = String(d.color || '').trim()
        .replace(/ELECTRONIC\s+ORANGE/i, 'E. ORANGE')
        .replace(/METALLIC\s+/i, 'MET. ')
        .replace(/ELECTRONIC\s+/i, 'E. ');

      const formattedRc = {
        regNo: d.rc_number || lookupKey,
        regDate: formatDateDisplay(d.registration_date || ''),
        chassisNo: d.chassis_number || d.vehicle_chasi_number || '',
        engineNo: d.engine_number || d.vehicle_engine_number || '',
        maker: d.maker_description || d.maker_model || '',
        model: d.maker_model || '',
        bodyType: normalizedBody,
        wheelBase: String(d.wheelbase || '0'),
        mfgDate: d.manufacturing_date || '',
        fuel: String(d.fuel_type || 'PETROL').toUpperCase(),
        validUpto: formatDateDisplay(d.fit_up_to || d.fitness_upto || ''),
        taxUpto: d.tax_upto || 'LTT',
        owner: d.owner_name || '',
        swd: d.father_name || 'NA',
        address: enrichAddress(d.present_address || d.permanent_address, d.registered_at, lookupKey),
        ownerSerial: String(d.owner_serial_number || d.owner_number || '01'),
        color: normalizedColor,
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
         ON CONFLICT (lookup_key)
         DO UPDATE SET raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
        [docType, lookupKey, JSON.stringify(formattedRc)]
      ).catch(() => {});

      mockDatabase[lookupKey] = formattedRc;
      return formattedRc;

    } else if (docType === 'DL') {
      const cleanDob = normalizeDob(dob);

      let resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
        },
        body: JSON.stringify({ id_number: lookupKey, dob: cleanDob })
      });

      let json = await resp.json();

      if (json && json.status_code === 500 && json.message && json.message.includes('Timed Out')) {
        console.warn(`[Upstream Timeout] Retrying DL ${lookupKey} in 1.2 seconds...`);
        await new Promise(res => setTimeout(res, 1200));
        resp = await fetch(`${SUREPASS_BASE_URL}/api/v1/driving-license/driving-license`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUREPASS_BEARER_TOKEN}`
          },
          body: JSON.stringify({ id_number: lookupKey, dob: cleanDob })
        });
        json = await resp.json();
      }

      if (!resp.ok || !json.success || !json.data) {
        console.error('[Surepass DL Failed]:', json);
        return null;
      }

      const d = json.data;
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
          category: d.transport_doe && d.transport_doe !== '1800-01-01' ? 'TR' : 'NT',
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
        validUptoTR: d.transport_doe && d.transport_doe !== '1800-01-01' ? formatDateDisplay(d.transport_doe) : '',
        name: d.name || '',
        dob: formatDateDisplay(d.dob || cleanDob),
        bloodGroup: d.blood_group || '',
        organDonor: 'N',
        swd: d.father_or_husband_name || 'NA',
        address: enrichAddress(fullAddress, d.ola_name || d.issuing_authority, lookupKey),
        firstIssueDate: formatDateDisplay(d.initial_doi || d.doi || '10-06-2011'),
        profileImage: d.has_image && d.profile_image ? d.profile_image : '',
        adpVehNo: '',
        hazardousValidity: '',
        hillValidity: '',
        covList: parsedCovList,
        mobileNo: '',
        rtoAuthority: d.ola_name || d.issuing_authority || 'RTO OFFICE'
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
    console.error('Surepass Gateway Exception:', err);
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

// =====================================================================
// CUSTOMER AUTHENTICATION VIA MSG91 OTP WIDGET
// =====================================================================
app.post('/api/customer/send-otp', otpLimiter, async (req, res) => {
  const { mobile } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');

  if (cleanMobile.length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  if (cleanMobile === '9999999999' || cleanMobile === '1234567890') {
    otpStore.set(cleanMobile, {
      reqId: 'DEV_TEST',
      devTest: true,
      attempts: 0,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return res.json({ success: true, message: 'Test verification code active.', mobile: cleanMobile });
  }

  try {
    if (!MSG91_AUTH_KEY || !MSG91_TOKEN_AUTH) {
      return res.status(503).json({ error: 'SMS verification service is not configured.' });
    }

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
        devTest: false,
        attempts: 0,
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      return res.json({ success: true, message: 'Verification code sent via SMS.', mobile: cleanMobile });
    }

    console.error('[MSG91 Send Error]:', data);
    return res.status(400).json({ error: data.message || 'Failed to dispatch SMS OTP.' });
  } catch (err) {
    console.error('[MSG91 Gateway Exception]:', err.message);
    return res.status(500).json({ error: 'SMS service temporarily unavailable.' });
  }
});

app.post('/api/customer/verify-otp', otpLimiter, async (req, res) => {
  const { mobile, otp } = req.body;
  const cleanMobile = String(mobile || '').replace(/\D/g, '');
  const enteredOtp = String(otp || '').trim();

  if (cleanMobile.length !== 10) {
    return res.status(400).json({ error: 'Invalid mobile number.' });
  }

  const record = otpStore.get(cleanMobile);
  if (!record || !record.reqId) {
    return res.status(400).json({ error: 'No OTP session found for this number. Please request a new code.' });
  }

  if (!record.expiresAt || Date.now() > record.expiresAt) {
    otpStore.delete(cleanMobile);
    return res.status(400).json({ error: 'OTP session has expired. Please request a new code.' });
  }

  record.attempts = Number(record.attempts || 0) + 1;
  if (record.attempts > 5) {
    otpStore.delete(cleanMobile);
    return res.status(429).json({ error: 'Too many OTP attempts. Please request a new code.' });
  }

  if (record.devTest === true) {
    if (enteredOtp !== '1234') {
      return res.status(400).json({ error: 'Invalid or expired OTP code.' });
    }
    otpStore.delete(cleanMobile);
    const token = 'TOK_CUST_' + crypto.randomBytes(24).toString('hex');
    const customerId = 'CUST_' + cleanMobile;

    customers.set(customerId, {
      customerId,
      mobile: cleanMobile,
      sessionToken: token,
      verifiedAt: new Date(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    return res.json({ success: true, token, mobile: cleanMobile, message: 'Identity verified.' });
  }

  try {
    if (!MSG91_AUTH_KEY || !MSG91_TOKEN_AUTH) {
      return res.status(503).json({ error: 'SMS verification service is not configured.' });
    }

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
        verifiedAt: new Date(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      });

      return res.json({ success: true, token, mobile: cleanMobile, message: 'Mobile identity verified successfully.' });
    }

    return res.status(400).json({ error: data.message || 'Invalid or expired OTP code.' });
  } catch (err) {
    console.error('[MSG91 Verification Exception]:', err.message);
    return res.status(500).json({ error: 'Verification service error.' });
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
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const checkRes = await pool.query('SELECT agent_id FROM agents WHERE mobile = $1 OR email = $2', [mobile, email]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'Agent with this mobile or email already exists' });
    }

    const agentId = 'AGT_' + Date.now();
    const passwordHash = await hashPassword(password);

    await pool.query(
      `INSERT INTO agents (agent_id, name, mobile, email, password, address, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', NOW(), NOW())`,
      [agentId, name, mobile, email, passwordHash, address]
    );

    res.json({ success: true, agentId, amount: 500, paymentProvider: 'RAZORPAY' });
  } catch (err) {
    console.error('Agent Register DB Error:', err);
    res.status(500).json({ error: 'Failed to process registration' });
  }
});

app.post('/api/agent/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Mobile/email and password are required.' });
    }

    const dbRes = await pool.query(
      'SELECT * FROM agents WHERE mobile = $1 OR email = $1 LIMIT 1',
      [identifier]
    );

    if (dbRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid mobile/email or password' });
    }

    const agent = dbRes.rows[0];
    const passwordResult = await verifyPassword(password, agent.password);

    if (!passwordResult.valid) {
      return res.status(401).json({ error: 'Invalid mobile/email or password' });
    }

    if (passwordResult.legacy) {
      try {
        const newHash = await hashPassword(password);
        await pool.query('UPDATE agents SET password = $1, updated_at = NOW() WHERE agent_id = $2', [newHash, agent.agent_id]);
      } catch (migrationErr) {
        console.warn('[Agent Password Migration Warning]:', migrationErr.message);
      }
    }

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
      agent: { name: agent.name, mobile: agent.mobile, email: agent.email }
    });
  } catch (err) {
    console.error('Agent Login DB Error:', err);
    res.status(500).json({ error: 'Login query failed' });
  }
});

// =====================================================================
// ADMIN ROUTES
// =====================================================================
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  const { secretKey } = req.body;
  if (ADMIN_MASTER_SECRET && secretKey && safeEqual(secretKey, ADMIN_MASTER_SECRET)) {
    return res.json({ success: true, token: ADMIN_SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid Admin Master Secret Key' });
});

app.get('/api/admin/stats', async (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
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
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
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
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  try {
    const result = await pool.query(
      'SELECT agent_id, name, mobile, email, address, status, created_at FROM agents ORDER BY created_at DESC'
    );
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error('Admin Agents Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

app.post('/api/admin/update-agent-status', async (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
    return res.status(403).json({ error: 'Unauthorized admin access' });
  }

  const { agentId, status } = req.body;
  const allowedStatuses = ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid agent status.' });
  }

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
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
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
    pool.query(
      `INSERT INTO orders
        (order_id, user_phone, doc_type, lookup_key, amount, status, utr, created_at, paid_at, owner_id, owner_role, rzp_order_id, dob, rc_format)
       VALUES
        ($1, 'ADMIN', $2, $3, 0, 'SUCCESS', 'ADMIN_DIRECT', NOW(), NOW(), 'ADMIN', 'ADMIN', NULL, $4, $5)`,
      [adminOrderId, docType, targetNumber, normalizeDob(dob), rcFormat || 'OLD']
    ).catch((dbErr) => {
      console.warn('[Admin Direct Order Save Warning]:', dbErr.message);
    });

    const pdfBuffer = await generateVectorPdfBuffer(docType, rcFormat || 'OLD', report);
    const fileName = docType === 'DL' ? `DL_${report.dlNo || targetNumber}.pdf` : `RC_${report.regNo || targetNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Admin Direct Download Error:', err);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

app.post('/api/admin/clear-data', (req, res) => {
  const token = req.headers['authorization'];
  if (!token || !safeEqual(token, `Bearer ${ADMIN_SESSION_TOKEN}`)) {
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
app.post('/api/create-order', orderLimiter, async (req, res) => {
  try {
    await ordersSecuritySchemaReady;
    const { docType, targetNumber, tier, dob, rcFormat, customerMobile, customerEmail, customerName } = req.body;
    const authHeader = req.headers['authorization'] || '';
    const authContext = await resolveAuthContext(authHeader);
    const role = authContext.role;

    let finalAmount = 150;
    if (docType === 'AGENT_ONBOARDING') {
      finalAmount = 500;
    } else if (role === 'ADMIN') {
      finalAmount = 0;
    } else if (role === 'AGENT') {
      if (docType === 'DL') finalAmount = 80;
      else if (tier === '3-Wheeler') finalAmount = 120;
      else if (tier === '4-Wheeler+') finalAmount = 150;
      else finalAmount = 80;
    } else {
      if (docType === 'DL') finalAmount = 150;
      else if (tier === '3-Wheeler') finalAmount = 180;
      else if (tier === '4-Wheeler+') finalAmount = 200;
      else finalAmount = 150;
    }

    const localOrderId = 'ORD_' + Date.now();
    let rzpOrderId = null;

    if (role !== 'ADMIN' && finalAmount > 0) {
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        return res.status(500).json({ error: 'Razorpay keys not configured on server.' });
      }

      const options = {
        amount: Math.round(finalAmount * 100),
        currency: 'INR',
        receipt: localOrderId,
        notes: {
          docType: docType || 'RC',
          targetNumber: targetNumber || '',
          role
        }
      };

      const rzpOrder = await razorpay.orders.create(options);
      rzpOrderId = rzpOrder.id;
    }

    const effectiveOrderId = rzpOrderId || localOrderId;
    const initialStatus = role === 'ADMIN' ? 'SUCCESS' : 'PENDING';

    let ownerId = null;
    if (role === 'CUSTOMER') {
      ownerId = authContext.mobile || customerMobile || null;
    } else if (role === 'AGENT') {
      ownerId = authContext.agentId;
    } else if (role === 'ADMIN') {
      ownerId = 'ADMIN';
    } else if (customerMobile) {
      ownerId = customerMobile;
    }

    const orderData = {
      orderId: effectiveOrderId,
      rzpOrderId,
      localOrderId,
      docType,
      targetNumber,
      tier,
      amount: finalAmount,
      role,
      ownerId,
      dob: normalizeDob(dob),
      rcFormat: rcFormat || 'OLD',
      status: initialStatus,
      paymentProvider: 'RAZORPAY',
      currency: 'INR',
      customerMobile: customerMobile || '',
      customerEmail: customerEmail || '',
      customerName: customerName || '',
      paidAt: role === 'ADMIN' ? new Date() : null,
      createdAt: new Date()
    };

    orders.set(effectiveOrderId, orderData);

    try {
      await pool.query(
        `INSERT INTO orders
          (order_id, user_phone, doc_type, lookup_key, amount, status, created_at, paid_at, owner_id, owner_role, rzp_order_id, dob, rc_format)
         VALUES
          ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11, $12)
         ON CONFLICT (order_id)
         DO UPDATE SET
           status = EXCLUDED.status,
           paid_at = EXCLUDED.paid_at,
           owner_id = EXCLUDED.owner_id,
           owner_role = EXCLUDED.owner_role,
           rzp_order_id = EXCLUDED.rzp_order_id,
           dob = EXCLUDED.dob,
           rc_format = EXCLUDED.rc_format`,
        [
          effectiveOrderId,
          customerMobile || '',
          docType,
          targetNumber,
          finalAmount,
          initialStatus,
          role === 'ADMIN' ? new Date() : null,
          ownerId,
          role,
          rzpOrderId,
          normalizeDob(dob),
          rcFormat || 'OLD'
        ]
      );
    } catch (pgErr) {
      console.warn('[PostgreSQL Order Save Warning]:', pgErr.message);
    }

    res.json({
      success: true,
      orderId: effectiveOrderId,
      amount: finalAmount,
      amountPaise: Math.round(finalAmount * 100),
      currency: 'INR',
      keyId: RAZORPAY_KEY_ID,
      role,
      paymentProvider: 'RAZORPAY'
    });
  } catch (err) {
    console.error('Create Order Error:', err);
    res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
  }
});

// =====================================================================
// PAYMENT VERIFICATION
// =====================================================================
app.post('/api/verify-payment', async (req, res) => {
  try {
    await ordersSecuritySchemaReady;
    const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const lookupId = razorpay_order_id || orderId;

    if (!lookupId) {
      return res.status(400).json({ error: 'Order ID is required.' });
    }

    let order = orders.get(lookupId);

    if (!order) {
      try {
        const dbOrderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1 OR rzp_order_id = $1', [lookupId]);
        if (dbOrderRes.rows && dbOrderRes.rows.length > 0) {
          const row = dbOrderRes.rows[0];
          order = {
            orderId: row.order_id,
            rzpOrderId: row.rzp_order_id || row.order_id,
            docType: row.doc_type,
            targetNumber: row.lookup_key,
            amount: Number(row.amount),
            role: row.owner_role || 'PUBLIC',
            ownerId: row.owner_id || null,
            dob: row.dob || '',
            rcFormat: row.rc_format || 'OLD',
            status: row.status,
            currency: 'INR',
            paidAt: row.paid_at,
            paymentId: row.utr
          };
          orders.set(lookupId, order);
        }
      } catch (pgOrderErr) {
        console.warn('[PostgreSQL Order Lookup Warning]:', pgOrderErr.message);
      }
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const authHeader = req.headers['authorization'] || '';
    const authContext = await resolveAuthContext(authHeader);

    // ADMIN orders can only be verified by ADMIN.
    if (order.role === 'ADMIN' && authContext.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Unauthorized order access.' });
    }

    // Process Admin Free Orders
    if (order.role === 'ADMIN') {
      order.status = 'SUCCESS';
      order.paidAt = order.paidAt || new Date();
      order.paymentId = order.paymentId || ('RZP_ADM_' + crypto.randomBytes(6).toString('hex'));

      pool.query(
        'UPDATE orders SET status = $1, paid_at = $2, utr = $3 WHERE order_id = $4',
        ['SUCCESS', order.paidAt, order.paymentId, lookupId]
      ).catch(() => {});
    } else {
      // Normal Customer/Agent Payment through Razorpay
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        if (order.status !== 'SUCCESS') {
          return res.json({
            status: 'PENDING',
            orderId: order.orderId,
            message: 'Awaiting payment verification.'
          });
        }
      } else {
        const expectedRzpOrderId = order.rzpOrderId || order.orderId;
        if (!safeEqual(razorpay_order_id, expectedRzpOrderId)) {
          return res.status(400).json({ error: 'Razorpay order does not match this order.' });
        }

        // Verify HMAC SHA256 Signature
        const textToSign = `${razorpay_order_id}|${razorpay_payment_id}`;
        const generatedSig = crypto
          .createHmac('sha256', RAZORPAY_KEY_SECRET)
          .update(textToSign)
          .digest('hex');

        if (!safeEqual(generatedSig, razorpay_signature)) {
          return res.status(400).json({ error: 'Payment signature verification failed.' });
        }

        // Double check payment with Razorpay API
        let payment;
        try {
          payment = await razorpay.payments.fetch(razorpay_payment_id);
        } catch (gatewayErr) {
          console.error('[Razorpay Payment Fetch Error]:', gatewayErr.message);
          return res.status(502).json({ error: 'Unable to verify payment with Razorpay.' });
        }

        if (!payment || payment.id !== razorpay_payment_id) {
          return res.status(400).json({ error: 'Invalid Razorpay payment.' });
        }

        const expectedAmountPaise = Math.round(Number(order.amount) * 100);
        if (Number(payment.amount) !== expectedAmountPaise) {
          return res.status(400).json({ error: 'Paid amount does not match the order.' });
        }

        // Bind verified ownership if available
        if (authContext.mobile && !order.ownerId) {
          order.ownerId = authContext.mobile;
        }

        order.status = 'SUCCESS';
        order.paidAt = new Date();
        order.paymentId = razorpay_payment_id;

        pool.query(
          'UPDATE orders SET status = $1, paid_at = $2, utr = $3, owner_id = COALESCE(owner_id, $4) WHERE order_id = $5',
          ['SUCCESS', order.paidAt, order.paymentId, order.ownerId, lookupId]
        ).catch((dbErr) => {
          console.warn('[Payment DB Update Warning]:', dbErr.message);
        });
      }
    }

    if (order.status !== 'SUCCESS') {
      return res.json({
        status: 'PENDING',
        orderId: order.orderId,
        message: 'Awaiting payment verification.'
      });
    }

    if (order.docType === 'AGENT_ONBOARDING') {
      return res.json({
        status: 'SUCCESS',
        orderId: order.orderId,
        docType: order.docType,
        message: 'Agent fee verified successfully.'
      });
    }

    const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);

    if (!report) {
      let refundId = null;
      if (order.paymentId && order.paymentId.startsWith('pay_')) {
        try {
          console.warn(`[Auto-Refund] Triggering instant refund for ${order.paymentId}...`);
          const refund = await razorpay.payments.refund(order.paymentId, {
            amount: Math.round(order.amount * 100),
            speed: 'optimum',
            notes: { reason: 'Data retrieval server slow', orderId: order.orderId }
          });
          refundId = refund.id;
          order.status = 'REFUNDED';
          pool.query('UPDATE orders SET status = $1, utr = $2 WHERE order_id = $3', ['REFUNDED', refundId, lookupId]).catch(() => {});
        } catch (refundErr) {
          console.error('[Auto-Refund Gateway Error]:', refundErr.message);
        }
      }

      return res.json({
        status: refundId ? 'REFUNDED' : 'SUCCESS',
        orderId: order.orderId,
        refundId,
        amount: order.amount,
        message: refundId
          ? 'Server is slow at the moment. Your amount has been refunded.'
          : 'Payment verified, but the requested record could not be retrieved.'
      });
    }

    res.json({
      status: 'SUCCESS',
      orderId: order.orderId,
      docType: order.docType,
      rcFormat: order.rcFormat || 'OLD',
      amount: order.amount,
      currency: order.currency || 'INR',
      role: order.role,
      paymentProvider: 'RAZORPAY',
      paymentId: order.paymentId,
      report
    });
  } catch (err) {
    console.error('Verify Payment Error:', err);
    res.status(500).json({ error: 'Payment verification failed.' });
  }
});

// =====================================================================
// RAZORPAY WEBHOOK
// =====================================================================
app.post('/api/bank-webhook', async (req, res) => {
  try {
    await ordersSecuritySchemaReady;

    if (!RAZORPAY_WEBHOOK_SECRET) {
      return res.status(503).send('Webhook secret not configured');
    }

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-razorpay-signature'] || '';

    if (!signature) {
      return res.status(401).send('Missing webhook signature');
    }

    const expectedSig = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (!safeEqual(expectedSig, signature)) {
      return res.status(401).send('Bad webhook signature');
    }

    const payload = req.body || {};
    const event = payload.event;

    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload.payload?.payment?.entity || null;
      const orderEntity = payload.payload?.order?.entity || null;
      const rzpOrderId = paymentEntity?.order_id || orderEntity?.id || null;
      const paymentId = paymentEntity?.id || null;

      if (!rzpOrderId) return res.status(200).json({ status: 'ignored' });

      let o = orders.get(rzpOrderId);

      if (!o) {
        try {
          const dbRes = await pool.query(
            'SELECT * FROM orders WHERE order_id = $1 OR rzp_order_id = $1 LIMIT 1',
            [rzpOrderId]
          );
          if (dbRes.rows.length > 0) {
            const row = dbRes.rows[0];
            o = {
              orderId: row.order_id,
              rzpOrderId: row.rzp_order_id || row.order_id,
              docType: row.doc_type,
              targetNumber: row.lookup_key,
              amount: Number(row.amount),
              role: row.owner_role || 'PUBLIC',
              ownerId: row.owner_id || null,
              dob: row.dob || '',
              rcFormat: row.rc_format || 'OLD',
              status: row.status,
              currency: 'INR',
              paidAt: row.paid_at,
              paymentId: row.utr
            };
            orders.set(o.orderId, o);
          }
        } catch (dbErr) {
          console.error('[Webhook DB Lookup Error]:', dbErr.message);
        }
      }

      if (o) {
        o.status = 'SUCCESS';
        o.paidAt = new Date();
        if (paymentId) o.paymentId = paymentId;

        pool.query(
          'UPDATE orders SET status = $1, paid_at = NOW(), utr = COALESCE($2, utr) WHERE order_id = $3 OR rzp_order_id = $3',
          ['SUCCESS', paymentId, o.orderId]
        ).catch((dbErr) => {
          console.error('[Webhook DB Update Error]:', dbErr.message);
        });
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Razorpay Webhook Error:', err);
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

  function splitAddress(addr, maxChars = 40) {
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

    const dlStateCode = String(report.dlNo || 'KA').replace(/[^A-Z]/g, '').substring(0, 2).toUpperCase();
    const dlStateFullName = STATE_NAMES[dlStateCode] || 'KARNATAKA';

    const dlSubTitleText = `Issued by Transport Department, Government of ${dlStateFullName}`;
    let dlSubTitleSize = 5.6 * S;
    while (dlSubTitleSize > 4.0 * S && fontBold.widthOfTextAtSize(dlSubTitleText, dlSubTitleSize) > 170.0 * S) {
      dlSubTitleSize -= 0.2;
    }
    const dlSubTitleWidth = fontBold.widthOfTextAtSize(dlSubTitleText, dlSubTitleSize);
    page.drawText(dlSubTitleText, {
      x: leftCardX + ((cardW - dlSubTitleWidth) / 2),
      y: cardY + ((CARD_HEIGHT - 21.0) * S),
      size: dlSubTitleSize,
      font: fontBold,
      color: rgb(0.05, 0.15, 0.3)
    });

    // Draw DL State Badge in Orange Circle (~ top-right) with black text
    const dlBadgeText = dlStateCode;
    const dlBadgeW = fontBold.widthOfTextAtSize(dlBadgeText, 5.5 * S);
    page.drawText(dlBadgeText, {
      x: leftCardX + (224.0 * S) - (dlBadgeW / 2),
      y: cardY + ((CARD_HEIGHT - 12.3) * S),
      size: 5.5 * S,
      font: fontBold,
      color: rgb(0, 0, 0)
    });

    if (report.profileImage) {
      try {
        const cleanBase64 = String(report.profileImage).replace(/^data:image\/\w+;base64,/, '').trim();
        const rawPhotoBuffer = Buffer.from(cleanBase64, 'base64');
        const photoPng = await sharp(rawPhotoBuffer)
          .resize(150, 180, { fit: 'cover' })
          .png()
          .toBuffer();

        const embeddedPhoto = await pdfDoc.embedPng(photoPng);
        page.drawImage(embeddedPhoto, {
          x: leftCardX + (193.5 * S),
          y: cardY + ((CARD_HEIGHT - 72.0) * S),
          width: 33.0 * S,
          height: 39.0 * S
        });
      } catch (photoErr) {
        console.warn('Driver photo embed warning:', photoErr.message);
      }
    }

    try {
      const sigPngBuffer = await generateSignaturePng(report.name || 'Driver');
      const embeddedSig = await pdfDoc.embedPng(sigPngBuffer);
      page.drawImage(embeddedSig, {
        x: leftCardX + (191.0 * S),
        y: cardY + ((CARD_HEIGHT - 76.2) * S),
        width: 35.0 * S,
        height: 7.2 * S
      });
    } catch (sigErr) {
      console.warn('Signature generator warning:', sigErr.message);
    }

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

    page.drawText(String(report.swd || 'NA').trim(), {
      x: leftCardX + (79.0 * S),
      y: cardY + ((CARD_HEIGHT - 122.5) * S),
      size: 6.5 * S,
      font: fontRegular,
      color: softTextColor
    });

    const dlAddrLines = splitAddress(report.address || '', 40);
    dlAddrLines.slice(0, 3).forEach((line, idx) => {
      page.drawText(String(line).trim(), {
        x: leftCardX + (35.0 * S),
        y: cardY + ((CARD_HEIGHT - (134.0 + (idx * 5.8))) * S),
        size: 5.5 * S,
        font: fontRegular,
        color: softTextColor
      });
    });

    page.drawText(`( ${report.firstIssueDate || report.doi || '10-06-2011'} )`, {
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
      for (let idx = 0; idx < Math.min(report.covList.length, 5); idx++) {
        const cov = report.covList[idx];
        const rowPitch = 11.0;
        const rowY = 83.6 + (idx * rowPitch);

        try {
          const codeUpper = String(cov.code || '').trim().toUpperCase();
          const isCrane = codeUpper.includes('CRANE');
          const isCar = cov.covType === 'CAR' || codeUpper.includes('LMV');
          const iconBuffer = isCrane ? SVG_ICONS.CRANE : (isCar ? SVG_ICONS.CAR : SVG_ICONS.BIKE);

          const iconPng = await sharp(iconBuffer).resize(60, 30, { fit: 'contain' }).png().toBuffer();
          const embeddedIcon = await pdfDoc.embedPng(iconPng);

          page.drawImage(embeddedIcon, {
            x: rightCardX + (18.0 * S),
            y: cardY + ((CARD_HEIGHT - (rowY + 2.0)) * S),
            width: 11.5 * S,
            height: 5.8 * S
          });
        } catch (e) {
          console.warn('Icon draw warning:', e.message);
        }

        const codeVal = String(cov.code || '').trim();
        let codeFontSize = codeVal.length > 4 ? 4.7 * S : 5.8 * S;
        const codeW = fontRegular.widthOfTextAtSize(codeVal, codeFontSize);

        page.drawText(codeVal, {
          x: rightCardX + (47.5 * S) - (codeW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: codeFontSize,
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
          x: rightCardX + (107.5 * S) - (doiW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 4.8 * S,
          font: fontRegular,
          color: softTextColor
        });

        const catVal = String(cov.category || 'NT').trim();
        const catW = fontRegular.widthOfTextAtSize(catVal, 5.8 * S);

        page.drawText(catVal, {
          x: rightCardX + (137.0 * S) - (catW / 2),
          y: cardY + ((CARD_HEIGHT - rowY) * S),
          size: 5.8 * S,
          font: fontRegular,
          color: softTextColor
        });
      }
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

    const rtoVal = String(report.rtoAuthority || 'RTO OFFICE').trim();
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
    const stateFullName = STATE_NAMES[stateCode] || 'KARNATAKA';

    const frontCandidates = isKA ? ['new_rc_front.png', 'new_rc_.png', 'new_rc.png'] : ['national_rc_front.png', 'new_rc_front.png', 'new_rc.png'];
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

    const backCandidates = isKA ? ['new_rc_back.png', 'new_rc_back_.png'] : ['national_rc_back.png', 'new_rc_back.png', 'new_rc_back_.png'];
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

    // Draw RC Badges (Blue = NT/TR, Orange = State Code) with black text
    if (!isKA) {
      const isCommercial = isCommercialClass(report.vehicleClassFull);
      const blueBadgeText = isCommercial ? 'TR' : 'NT';
      const orangeBadgeText = stateCode;

      const blueW = fontBold.widthOfTextAtSize(blueBadgeText, 5.0 * S);
      page.drawText(blueBadgeText, {
        x: leftCardX + (205.5 * S) - (blueW / 2),
        y: cardY + ((CARD_HEIGHT - 12.3) * S),
        size: 5.0 * S,
        font: fontBold,
        color: rgb(0, 0, 0)
      });

      const orangeW = fontBold.widthOfTextAtSize(orangeBadgeText, 5.0 * S);
      page.drawText(orangeBadgeText, {
        x: leftCardX + (224.0 * S) - (orangeW / 2),
        y: cardY + ((CARD_HEIGHT - 12.3) * S),
        size: 5.0 * S,
        font: fontBold,
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
      swdName: report.swd || 'NA',
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
        const lines = splitAddress(val, 40);
        lines.slice(0, cfg.maxLines).forEach((line, idx) => {
          const posX = idx === 1 && cfg.line2X ? cfg.line2X : cfg.x;
          page.drawText(String(line).trim(), {
            x: leftCardX + (posX * S),
            y: cardY + ((baselineY - (idx * cfg.lineHeight)) * S),
            size: cfg.size * S,
            font,
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
          font,
          color: textColor
        });
      }
    });

    const backData = {
      vehicleClass: report.vehicleClassFull || 'M-Cycel/Scooter (2WN)',
      regNo: report.regNo || '',
      maker: report.maker || '',
      model: report.model || '',
      bodyType: report.bodyType || '',
      seatingCapacity: report.seating ? String(report.seating) : '2',
      standingCapacity: report.stdgSlpr ? report.stdgSlpr.split('/')[0].trim() : '0',
      sleeperCapacity: '0',
      mfgDate: report.mfgDate || '',
      unladenWeight: report.unladenWt ? String(report.unladenWt) : '109',
      ladenWeight: report.ladenWt ? String(report.ladenWt) : '239',
      grossWeight: '0',
      cylinders: report.cylinders ? String(report.cylinders) : '1',
      cubicCapacity: report.cubicCap ? String(report.cubicCap) : '109.7',
      horsePower: report.horsePower ? String(report.horsePower) : '7.37',
      wheelbase: report.wheelBase ? String(report.wheelBase) : '1275',
      financer: report.financer || '',
      rtoAuthority: report.rto || 'CHICKABALLAPURA RTO'
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
          font,
          color: softTextColor
        });
      } else {
        page.drawText(String(val).trim(), {
          x: rightCardX + (cfg.x * S),
          y: cardY + (baselineY * S),
          size: fontSize,
          font,
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
      page.drawImage(frontImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
    }

    page.drawRectangle({
      x: rightCardX,
      y: cardY,
      width: cardW,
      height: cardH,
      color: rgb(1, 1, 1)
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
        value = String(value).replace(/\s*\(?2WN\)?\s*/i, '').trim();
      }
      if (field.label === 'COLOUR' && value) {
        value = String(value)
          .replace(/ELECTRONIC\s+ORANGE/i, 'E. ORANGE')
          .replace(/METALLIC\s+/i, 'MET. ')
          .replace(/ELECTRONIC\s+/i, 'E. ')
          .trim();
      }
      drawText(field.label, field.labelX, field.y, field.fontSize, 28);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 56);
    });

    fieldLayout.middle.forEach((field) => {
      const value = field.label === 'S/W/D OF' ? (report.swd || 'NA') : report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      drawText(':', field.colonX, field.y, field.fontSize, 5);

      if (field.multiLine && value) {
        const lines = splitAddress(value, 40);
        lines.slice(0, field.maxLines).forEach((line, idx) => {
          const lineY = field.y - (idx * field.lineHeight);
          drawText(line, field.valueX, lineY, 5.8, 175);
        });
      } else {
        drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 175);
      }
    });

    fieldLayout.bottomLeft.forEach((field) => {
      let value = report[getFieldKey(field.label)];
      if (field.label === 'BODY' && value && /SOLO/i.test(String(value))) value = 'SOLO';
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

// =====================================================================
// SECURE PDF DOWNLOAD ROUTE
// =====================================================================
app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    await ordersSecuritySchemaReady;
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const authHeader = req.headers['authorization'] || '';
    const authContext = await resolveAuthContext(authHeader);

    let order = orders.get(orderId);

    if (!order) {
      const dbOrderRes = await pool.query('SELECT * FROM orders WHERE order_id = $1 OR rzp_order_id = $1', [orderId]);
      if (dbOrderRes.rows && dbOrderRes.rows.length > 0) {
        const row = dbOrderRes.rows[0];
        order = {
          orderId: row.order_id,
          rzpOrderId: row.rzp_order_id || row.order_id,
          docType: row.doc_type,
          targetNumber: row.lookup_key,
          amount: Number(row.amount),
          status: row.status,
          role: row.owner_role || 'PUBLIC',
          ownerId: row.owner_id || null,
          dob: row.dob || '',
          rcFormat: row.rc_format || 'OLD',
          paymentId: row.utr
        };
      }
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'SUCCESS') {
      return res.status(403).json({ error: 'Payment has not been verified for this order.' });
    }

    // Permission Verification
    if (authContext.role === 'ADMIN') {
      // Admin bypass
    } else if (order.role === 'ADMIN') {
      return res.status(403).json({ error: 'Unauthorized to download admin-generated document.' });
    } else if (authContext.role === 'CUSTOMER' && order.ownerId && authContext.mobile) {
      if (!safeEqual(authContext.mobile, order.ownerId)) {
        return res.status(403).json({ error: 'This document was purchased by another user.' });
      }
    } else if (authContext.role === 'AGENT' && order.ownerId && authContext.agentId) {
      if (!safeEqual(authContext.agentId, order.ownerId)) {
        return res.status(403).json({ error: 'This document was ordered by another agent.' });
      }
    }

    const report = await getVehicleOrDlRecord(order.docType, order.targetNumber, order.dob);
    if (!report) {
      return res.status(404).json({ error: 'Record could not be retrieved.' });
    }

    const pdfBuffer = await generateVectorPdfBuffer(order.docType, order.rcFormat || 'OLD', report);
    const fileName = order.docType === 'DL' ? `DL_${report.dlNo || 'Document'}.pdf` : `RC_${report.regNo || 'Document'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF Generation Error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// =====================================================================
// FIELD MAPPING
// =====================================================================
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

// =====================================================================
// SERVER START
// =====================================================================
app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Backend Running at: http://localhost:${PORT}`);
});