const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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
    vehicleClassFull: 'M-Cycle/Scooter(2WN)',
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
    vehicleClassFull: 'M-Cycle/Scooter(2WN)',
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
    vehicleClassFull: 'M-Cycle/Scooter(2WN)',
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
// EXACT ALIGNED LAYOUT COORDINATES (CR80 ID CARD RATIO: 242.88 x 153.0)
// =====================================================================
const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

const fieldLayout = {
  // HEADER
  header: {
    regNo: { label: 'REG NO :', labelX: 55, valueX: 102, y: 139, fontSize: 9.5 },
    form: { label: 'FORM-23A', x: 200, y: 140, fontSize: 6.5 },
    formNote: { label: '(See Rule 48)', x: 195, y: 134, fontSize: 5.5 }
  },

  // TOP-LEFT BLOCK (Column 1)
  topLeft: [
    { label: 'REG.DATE', labelX: 6, dotX: 42, colonX: 58, valueX: 63, y: 125, fontSize: 6.8, isDot: true },
    { label: 'CHASSIS NO.', labelX: 6, dotX: 46, colonX: 58, valueX: 63, y: 118, fontSize: 6.8, isDot: true },
    { label: 'ENGINE NO', labelX: 6, dotX: 44, colonX: 58, valueX: 63, y: 111, fontSize: 6.8, isDot: true },
    { label: 'MFR', labelX: 6, colonX: 58, valueX: 63, y: 104, fontSize: 6.8, isDot: false, maxW: 175 }
  ],

  // TOP-RIGHT BLOCK (Column 2)
  topRight: [
    { label: 'O SLNO', labelX: 160, colonX: 190, valueX: 195, y: 125, fontSize: 6.8, maxW: 44 },
    { label: 'CLASS', labelX: 160, colonX: 190, valueX: 195, y: 118, fontSize: 6.8, maxW: 65 },
    { label: 'COLOUR', labelX: 160, colonX: 190, valueX: 195, y: 111, fontSize: 6.8, maxW: 44 }
  ],

  // MIDDLE: OWNER & ADDRESS
  middle: [
    { label: 'OWNERNAME', labelX: 6, colonX: 58, valueX: 63, y: 92, fontSize: 6.8, maxW: 175 },
    { label: 'S/W/D OF', labelX: 6, colonX: 58, valueX: 63, y: 85, fontSize: 6.8, maxW: 175 },
    { label: 'ADDRESS', labelX: 6, colonX: 58, valueX: 63, y: 78, fontSize: 6.8, multiLine: true, maxLines: 2, lineHeight: 6.5, maxW: 175 }
  ],

  // BOTTOM-LEFT BLOCK (Specs)
  bottomLeft: [
    { label: 'MODEL', labelX: 6, colonX: 58, valueX: 63, y: 56, fontSize: 6.8, maxW: 75 },
    { label: 'BODY', labelX: 6, colonX: 58, valueX: 63, y: 49, fontSize: 6.8, maxW: 75 },
    { label: 'WHEEL BASE', labelX: 6, colonX: 58, valueX: 63, y: 42, fontSize: 6.8, maxW: 75 },
    { label: 'MFG DATE', labelX: 6, colonX: 58, valueX: 63, y: 35, fontSize: 6.8, maxW: 75 },
    { label: 'FUEL', labelX: 6, colonX: 58, valueX: 63, y: 28, fontSize: 6.8, maxW: 75 },
    { label: 'REG/FC UPTO', labelX: 6, colonX: 58, valueX: 63, y: 21, fontSize: 6.8, maxW: 75 },
    { label: 'TAX UPTO', labelX: 6, colonX: 58, valueX: 63, y: 14, fontSize: 6.8, maxW: 75 }
  ],

  // BOTTOM-RIGHT BLOCK (Specs - Synchronized with Page 2 Grid)
  bottomRight: [
    { label: 'NO.OF CYL', labelX: 140, dotX: 170, colonX: 188, valueX: 194, y: 56, fontSize: 6.8, isDot: true, maxW: 45 },
    { label: 'UNLADEN WT', labelX: 140, colonX: 188, valueX: 194, y: 49, fontSize: 6.8, maxW: 45 },
    { label: 'SEATING', labelX: 140, colonX: 188, valueX: 194, y: 42, fontSize: 6.8, maxW: 45 },
    { label: 'STDG/SLPR', labelX: 140, colonX: 188, valueX: 194, y: 35, fontSize: 6.8, maxW: 45 },
    { label: 'CC', labelX: 140, colonX: 188, valueX: 194, y: 28, fontSize: 6.8, maxW: 45 }
  ],

  // FOOTER
  footer: {
    authority: { label: 'Registering Authority', x: 165, y: 14, fontSize: 6.5 },
    rto: { x: 165, y: 7, fontSize: 6.8 }
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
// MAIN BACKEND VECTOR PDF ENGINE
// =====================================================================
app.post('/api/download-rc-pdf', async (req, res) => {
  try {
    const { report } = req.body;
    if (!report) {
      return res.status(400).json({ error: 'Report data is required' });
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([841.89, 595.28]); // A4 Landscape
    const { width, height } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Scale Factor: Card rendered at 370 x 233 pt
    const S = 370 / CARD_WIDTH; // 1.5234
    const cardW = 370;
    const cardH = CARD_HEIGHT * S;
    const gap = 20;
    const totalW = (cardW * 2) + gap;
    const startX = (width - totalW) / 2;
    const startY = (height - cardH) / 2;

    const leftCardX = startX;
    const rightCardX = startX + cardW + gap;
    const cardY = startY;

    // 1. LEFT CARD: FRONT BANNER
    const frontImgPath = path.join(__dirname, 'public', 'assets', 'templates', 'ka_front_hd.png');
    if (fs.existsSync(frontImgPath)) {
      const frontImgBytes = fs.readFileSync(frontImgPath);
      const frontImg = await pdfDoc.embedPng(frontImgBytes);
      page.drawImage(frontImg, {
        x: leftCardX,
        y: cardY,
        width: cardW,
        height: cardH,
      });
    }

    page.drawRectangle({
      x: leftCardX,
      y: cardY,
      width: cardW,
      height: cardH,
      borderColor: rgb(0.39, 0.45, 0.55),
      borderWidth: 1,
    });

    // 2. RIGHT CARD: WHITE BACKGROUND & BORDER
    page.drawRectangle({
      x: rightCardX,
      y: cardY,
      width: cardW,
      height: cardH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.39, 0.45, 0.55),
      borderWidth: 1,
    });

    // Text Drawer with automatic scale-down for overflow
    function drawText(text, x, y, size, maxWidth = 170) {
      if (!text) return;
      
      let fontSize = size * S;
      let displayText = String(text).trim();
      
      while (fontSize > 4.5 * S && fontBold.widthOfTextAtSize(displayText, fontSize) > maxWidth * S) {
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

    // HEADER
    drawText(fieldLayout.header.regNo.label, fieldLayout.header.regNo.labelX, fieldLayout.header.regNo.y, fieldLayout.header.regNo.fontSize, 45);
    drawText(report.regNo, fieldLayout.header.regNo.valueX, fieldLayout.header.regNo.y, fieldLayout.header.regNo.fontSize, 110);
    drawText(fieldLayout.header.form.label, fieldLayout.header.form.x, fieldLayout.header.form.y, fieldLayout.header.form.fontSize, 40);
    drawText(fieldLayout.header.formNote.label, fieldLayout.header.formNote.x, fieldLayout.header.formNote.y, fieldLayout.header.formNote.fontSize, 40);

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
      const value = report[getFieldKey(field.label)];
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
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 75);
    });

    // BOTTOM-RIGHT BLOCK (Specs)
    fieldLayout.bottomRight.forEach((field) => {
      const value = report[getFieldKey(field.label)];
      drawText(field.label, field.labelX, field.y, field.fontSize, 46);
      if (field.isDot) drawText('.', field.dotX, field.y, field.fontSize, 5);
      drawText(':', field.colonX, field.y, field.fontSize, 5);
      drawText(value, field.valueX, field.y, field.fontSize, field.maxW || 45);
    });

    // FOOTER
    drawText(fieldLayout.footer.authority.label, fieldLayout.footer.authority.x, fieldLayout.footer.authority.y, fieldLayout.footer.authority.fontSize, 75);
    drawText(report.rto, fieldLayout.footer.rto.x, fieldLayout.footer.rto.y, fieldLayout.footer.rto.fontSize, 75);

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