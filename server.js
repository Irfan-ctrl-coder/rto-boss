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
    rto: 'MYSORE WEST RTO'
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
    rto: 'BENGALURU WEST RTO'
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
    rto: 'CHANDAPURA, BENGALURU RTO'
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

// =====================================================================
// EXACT ALIGNED LAYOUT COORDINATES (CANVA MASTER MATCH)
// =====================================================================
const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

const fieldLayout = {
  // HEADER
  header: {
    regNoY: 140.5,
    regNoFontSize: 9.5,
    form: { label: 'FORM-23A', rightAnchorX: 236.0, y: 141.0, fontSize: 6.5 },
    formNote: { label: '(See Rule 48)', rightAnchorX: 236.0, y: 135.0, fontSize: 5.5 }
  },

  // TOP-LEFT BLOCK (Column 1)
  topLeft: [
    { label: 'REG.DATE', labelX: 6, dotX: 42, colonX: 57, valueX: 62, y: 126, fontSize: 6.8, isDot: true },
    { label: 'CHASSIS NO.', labelX: 6, dotX: 46, colonX: 57, valueX: 62, y: 119, fontSize: 6.8, isDot: true },
    { label: 'ENGINE NO', labelX: 6, dotX: 44, colonX: 57, valueX: 62, y: 112, fontSize: 6.8, isDot: true },
    { label: 'MFR', labelX: 6, colonX: 57, valueX: 62, y: 105, fontSize: 6.8, isDot: false, maxW: 175 }
  ],

  // TOP-RIGHT BLOCK (Column 2)
  topRight: [
    { label: 'O SLNO', labelX: 148, colonX: 176, valueX: 181, y: 126, fontSize: 6.8, maxW: 44 },
    { label: 'CLASS', labelX: 148, colonX: 176, valueX: 181, y: 119, fontSize: 6.8, maxW: 65 },
    { label: 'COLOUR', labelX: 148, colonX: 176, valueX: 181, y: 112, fontSize: 6.8, maxW: 44 }
  ],

  // MIDDLE: OWNER & ADDRESS
  middle: [
    { label: 'OWNERNAME', labelX: 6, colonX: 57, valueX: 62, y: 93, fontSize: 6.8, maxW: 175 },
    { label: 'S/W/D OF', labelX: 6, colonX: 57, valueX: 62, y: 86, fontSize: 6.8, maxW: 175 },
    { label: 'ADDRESS', labelX: 6, colonX: 57, valueX: 62, y: 79, fontSize: 6.8, multiLine: true, maxLines: 2, lineHeight: 6.5, maxW: 175 }
  ],

  // BOTTOM-LEFT BLOCK (Specs)
  bottomLeft: [
    { label: 'MODEL', labelX: 6, colonX: 57, valueX: 62, y: 56, fontSize: 6.8, maxW: 120 },
    { label: 'BODY', labelX: 6, colonX: 57, valueX: 62, y: 49, fontSize: 6.8, maxW: 36 },
    { label: 'WHEEL BASE', labelX: 6, colonX: 57, valueX: 62, y: 42, fontSize: 6.8, maxW: 36 },
    { label: 'MFG DATE', labelX: 6, colonX: 57, valueX: 62, y: 35, fontSize: 6.8, maxW: 36 },
    { label: 'FUEL', labelX: 6, colonX: 57, valueX: 62, y: 28, fontSize: 6.8, maxW: 36 },
    { label: 'REG/FC UPTO', labelX: 6, colonX: 57, valueX: 62, y: 21, fontSize: 6.8, maxW: 36 },
    { label: 'TAX UPTO', labelX: 6, colonX: 57, valueX: 62, y: 14, fontSize: 6.8, maxW: 36 }
  ],

  // BOTTOM-RIGHT BLOCK
  bottomRight: [
    { label: 'NO.OF CYL', labelX: 98, dotX: 132, colonX: 146, valueX: 151, y: 49, fontSize: 6.8, isDot: true, maxW: 48 },
    { label: 'UNLADEN WT', labelX: 98, colonX: 146, valueX: 151, y: 42, fontSize: 6.8, maxW: 48 },
    { label: 'SEATING', labelX: 98, colonX: 146, valueX: 151, y: 35, fontSize: 6.8, maxW: 48 },
    { label: 'STDG/SLPR', labelX: 98, colonX: 146, valueX: 151, y: 28, fontSize: 6.8, maxW: 48 },
    { label: 'CC', labelX: 98, colonX: 146, valueX: 151, y: 21, fontSize: 6.8, maxW: 48 }
  ],

  // FOOTER
  footer: {
    authority: { label: 'Registering Authority', rightAnchorX: 236.0, y: 11.5, fontSize: 6.5 },
    rto: { rightAnchorX: 236.0, y: 4.0, fontSize: 6.8 }
  }
};

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
      ...mockDatabase['KA09HJ1161'],
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
// A4 PORTRAIT TOP-CENTERED VECTOR PDF ENGINE (CLEAN MASKED CORNERS)
// =====================================================================
app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    const { report } = req.body;
    if (!report) {
      return res.status(400).json({ error: 'Report data is required' });
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // ID Card Dimensions & Scaling
    const cardW = 260.0;
    const S = cardW / CARD_WIDTH; // 1.07048
    const cardH = CARD_HEIGHT * S; // 163.78 pt
    const gap = 14.0;

    const totalW = (cardW * 2) + gap;
    const startX = (width - totalW) / 2;
    const topMargin = 72.0;
    const startY = height - topMargin - cardH;

    const leftCardX = startX;
    const rightCardX = startX + cardW + gap;
    const cardY = startY;

    // 1. LEFT CARD: MASK BANNER WITH SMOOTH ROUNDED CORNERS
    const frontImgPath = path.join(__dirname, 'public', 'assets', 'templates', 'ka_front_hd.png');
    if (fs.existsSync(frontImgPath)) {
      const roundedMask = Buffer.from(`
        <svg width="1040" height="655">
          <rect x="0" y="0" width="1040" height="655" rx="32" ry="32" fill="#fff"/>
        </svg>
      `);

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

    // 2. RIGHT CARD: WHITE BACKGROUND BASE
    page.drawRectangle({
      x: rightCardX,
      y: cardY,
      width: cardW,
      height: cardH,
      color: rgb(1, 1, 1),
    });

    // Standard Left-Anchored Text Drawer
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

    // Right-Anchored Text Drawer
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

    // Centered Text Drawer
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

    // Split Address Helper
    function splitAddress(addr, maxChars = 42) {
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

    // ===== DRAW LAYOUT FIELDS =====

    // HEADER: Centered REG NO
    const fullRegNoText = `REG NO : ${report.regNo || ''}`;
    drawTextCenter(fullRegNoText, fieldLayout.header.regNoY, fieldLayout.header.regNoFontSize);

    // HEADER: Right-Anchored FORM-23A
    drawTextRightAnchor(fieldLayout.header.form.label, fieldLayout.header.form.rightAnchorX, fieldLayout.header.form.y, fieldLayout.header.form.fontSize);
    drawTextRightAnchor(fieldLayout.header.formNote.label, fieldLayout.header.formNote.rightAnchorX, fieldLayout.header.formNote.y, fieldLayout.header.formNote.fontSize);

    // TOP-LEFT BLOCK
    fieldLayout.topLeft.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      if (field.isDot) drawText('.', field.dotX, field.y, field.fontSize, 5);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 95);
    });

    // TOP-RIGHT BLOCK
    fieldLayout.topRight.forEach((field) => {
      let value = report[getFieldKey(field.label)];
      if (field.label === 'CLASS' && value) {
        value = String(value).replace(/\s*\(2WN\)\s*/i, '').trim();
      }
      drawText(field.label, field.labelX, field.y, field.fontSize, 28);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 65);
    });

    // MIDDLE: OWNER & ADDRESS
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

    // BOTTOM-LEFT BLOCK (Specs)
    fieldLayout.bottomLeft.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 120);
    });

    // BOTTOM-RIGHT BLOCK
    fieldLayout.bottomRight.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 48);
      if (field.isDot) drawText('.', field.dotX, field.y, field.fontSize, 5);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, 35);
    });

    // FOOTER
    drawTextRightAnchor(fieldLayout.footer.authority.label, fieldLayout.footer.authority.rightAnchorX, fieldLayout.footer.authority.y, fieldLayout.footer.authority.fontSize);
    drawTextRightAnchor(report.rto || 'RTO OFFICE', fieldLayout.footer.rto.rightAnchorX, fieldLayout.footer.rto.y, fieldLayout.footer.rto.fontSize);

    // -----------------------------------------------------------------
    // 3. IN-MEMORY ROUNDED BORDER OVERLAY
    // -----------------------------------------------------------------
    const roundedSvg = Buffer.from(`
      <svg width="1040" height="655" viewBox="0 0 1040 655" xmlns="http://www.w3.org/2000/svg">
        <rect x="3" y="3" width="1034" height="649" rx="32" ry="32" fill="none" stroke="#334155" stroke-width="5"/>
      </svg>
    `);
    
    const borderPngBuffer = await sharp(roundedSvg).png().toBuffer();
    const borderImg = await pdfDoc.embedPng(borderPngBuffer);

    // Overlay on Left Card
    page.drawImage(borderImg, {
      x: leftCardX,
      y: cardY,
      width: cardW,
      height: cardH,
    });

    // Overlay on Right Card
    page.drawImage(borderImg, {
      x: rightCardX,
      y: cardY,
      width: cardW,
      height: cardH,
    });

    // Save PDF
    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=RC_${report.regNo || 'Document'}.pdf`);
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    console.error('PDF Generation Error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// Helper: Map field labels to report keys
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