const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Order Storage
const orders = new Map();

// Mock Vehicle & DL Database
const mockDatabase = {
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
  'KA1120140002551': {
    dlNo: 'KA1120140002551',
    name: 'PAVAN KUMAR K',
    dob: '09-06-1995',
    swd: 'KALASAIAH',
    address: 'Javarayyana Beedi Kurupete Kanakapura, Kanakapura Ramanagar Karnataka 562117',
    doi: '23-08-2022',
    validUpto: '08-06-2035(nt)',
    cov: 'LMV, MCWG',
    rto: 'RAMANAGARA-(KA42)'
  }
};

const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

// Old Paper RC Layout
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

// =====================================================================
// 1. SMART CARD FRONT LAYOUT (100% LOCKED)
// =====================================================================
const newRcFrontLayout = {
  // Top Row (Bold Values)
  regNo:         { x: 56.0,  yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 65 },
  regDate:       { x: 126.0, yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 55 },
  validUpto:     { x: 186.0, yTop: 41.0,  size: 6.5, font: 'bold',    maxW: 55 },

  // Sub-details (All Regular Weight @ 6.5 pt)
  chassisNo:     { x: 56.7,  yTop: 58.5,  size: 6.5, font: 'regular', maxW: 140 },
  engineNo:      { x: 56.7,  yTop: 80.0,  size: 6.5, font: 'regular', maxW: 140 },
  ownerName:     { x: 56.7,  yTop: 96.0,  size: 6.5, font: 'regular', maxW: 140 },
  swdName:       { x: 56.7,  yTop: 114.5, size: 6.5, font: 'regular', maxW: 140 },

  // Bottom Row (Strictly aligned to shared baseline yTop: 135.5)
  fuel:          { x: 2.5,   yTop: 115.5, size: 6.5, font: 'regular', maxW: 55 },
  emissionNorms: { x: 1.0,   yTop: 135.5, size: 5.5, font: 'regular', maxW: 52 },
  address:       { x: 56.7,  line2X: 64.0, yTop: 135.5, size: 6.5, font: 'regular', multiLine: true, maxLines: 2, lineHeight: 6.8, maxW: 180 }
};

// =====================================================================
// 2. CALIBRATED SMART CARD BACK LAYOUT (CANVA EXACT MATRIX)
// =====================================================================
const newRcBackLayout = {
  // Top Blue Header Band: Vehicle Class
  vehicleClass:     { x: 101.0, yTop: 13.5, size: 6.0, font: 'regular', maxW: 120 },

  regNo:            { x: 10.0,  yTop: 32.5, size: 6.0, font: 'regular', maxW: 40 },
  maker:            { x: 58.0,  yTop: 32.5, size: 6.0, font: 'regular', maxW: 175 },
  model:            { x: 58.0,  yTop: 49.0, size: 6.0, font: 'regular', maxW: 175 },
  bodyType:         { x: 58.0,  yTop: 66.0, size: 6.0, font: 'regular', maxW: 175 },

  // Seating Row (Centered under Standing# and Sleeping# Capacity)
  seatingCapacity:  { x: 60.0,  yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  standingCapacity: { x: 104.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },
  sleeperCapacity:  { x: 138.0, yTop: 83.5, size: 6.0, font: 'regular', maxW: 15 },

  // Weights Row
  mfgDate:          { x: 10.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 35 },
  unladenWeight:    { x: 64.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  ladenWeight:      { x: 94.0,  yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },
  grossWeight:      { x: 126.0, yTop: 101.5, size: 6.0, font: 'regular', maxW: 20 },

  // Engine Specs Row
  cylinders:        { x: 18.0,  yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  cubicCapacity:    { x: 64.0,  yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  horsePower:       { x: 104.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 25 },
  wheelbase:        { x: 166.0, yTop: 119.5, size: 6.0, font: 'regular', maxW: 35 },

  // Footer Details (Untouched)
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

// =====================================================================
// API ENDPOINTS
// =====================================================================

app.post('/api/create-order', (req, res) => {
  const { docType, targetNumber, tier, amount, dob, rcFormat } = req.body;
  const orderId = 'ORD_' + Date.now();

  orders.set(orderId, {
    orderId,
    docType,
    targetNumber,
    tier,
    amount,
    dob,
    rcFormat: rcFormat || 'OLD',
    status: 'PENDING',
    createdAt: new Date()
  });

  res.json({ success: true, orderId, amount });
});

app.post('/api/verify-payment', (req, res) => {
  const { orderId } = req.body;
  const order = orders.get(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  order.status = 'SUCCESS';

  const lookupKey = order.targetNumber.replace(/[^A-Z0-9]/g, '');
  let report = mockDatabase[lookupKey];

  if (!report) {
    report = {
      ...mockDatabase['KA40EF5093'],
      regNo: order.targetNumber
    };
  }

  res.json({
    status: 'SUCCESS',
    orderId: order.orderId,
    docType: order.docType,
    rcFormat: order.rcFormat,
    report
  });
});

// =====================================================================
// A4 PORTRAIT VECTOR PDF ENGINE
// =====================================================================
app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    const { report, rcFormat } = req.body;
    if (!report) {
      return res.status(400).json({ error: 'Report data is required' });
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const cardW = 260.0;
    const S = cardW / CARD_WIDTH; // 1.070486
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

    if (rcFormat === 'NEW') {
      // 1. EMBED SMART CARD FRONT
      const frontPath = getTemplatePath(['new_rc_front.png', 'new_rc_.png', 'new_rc.png']);
      if (frontPath) {
        const maskedFrontPng = await sharp(frontPath)
          .resize(1040, 655)
          .composite([{ input: roundedMask, blend: 'dest-in' }])
          .png()
          .toBuffer();
        const frontImg = await pdfDoc.embedPng(maskedFrontPng);
        page.drawImage(frontImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
      }

      // 2. EMBED SMART CARD BACK
      const backPath = getTemplatePath(['new_rc_back.png', 'new_rc_back_.png']);
      if (backPath) {
        const maskedBackPng = await sharp(backPath)
          .resize(1040, 655)
          .composite([{ input: roundedMask, blend: 'dest-in' }])
          .png()
          .toBuffer();
        const backImg = await pdfDoc.embedPng(maskedBackPng);
        page.drawImage(backImg, { x: rightCardX, y: cardY, width: cardW, height: cardH });
      }

      // 3. DRAW FRONT FIELDS (100% LOCKED)
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

      // 4. DRAW BACK FIELDS (CALIBRATED ZERO-ALIGNMENT)
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
      // 1. OLD FORMAT FRONT CARD
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

      // 2. OLD FORMAT RIGHT CARD
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

    // Outer border overlay
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
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=RC_${report.regNo || 'Document'}.pdf`);
    res.send(Buffer.from(pdfBytes));

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