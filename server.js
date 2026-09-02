const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_MASTER_SECRET = 'ADMIN_MASTER_SECRET';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Storage
const orders = new Map();
const agents = new Map();

// All-India State Master Mapping
const STATE_NAMES = {
  AN: 'ANDAMAN AND NICOBAR',
  AP: 'ANDHRA PRADESH',
  AR: 'ARUNACHAL PRADESH',
  AS: 'ASSAM',
  BR: 'BIHAR',
  CG: 'CHHATTISGARH',
  CH: 'CHANDIGARH',
  DD: 'DAMAN AND DIU',
  DL: 'DELHI',
  DN: 'DADRA AND NAGAR HAVELI',
  GA: 'GOA',
  GJ: 'GUJARAT',
  HP: 'HIMACHAL PRADESH',
  HR: 'HARYANA',
  JH: 'JHARKHAND',
  JK: 'JAMMU AND KASHMIR',
  KA: 'KARNATAKA',
  KL: 'KERALA',
  LA: 'LADAKH',
  LD: 'LAKSHADWEEP',
  MH: 'MAHARASHTRA',
  ML: 'MEGHALAYA',
  MN: 'MANIPUR',
  MP: 'MADHYA PRADESH',
  MZ: 'MIZORAM',
  NL: 'NAGALAND',
  OD: 'ODISHA',
  PB: 'PUNJAB',
  PY: 'PUDUCHERRY',
  RJ: 'RAJASTHAN',
  SK: 'SIKKIM',
  TN: 'TAMIL NADU',
  TR: 'TRIPURA',
  TS: 'TELANGANA',
  UK: 'UTTARAKHAND',
  UP: 'UTTAR PRADESH',
  WB: 'WEST BENGAL'
};

// Mock Vehicle & DL Database
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
  'KA1320170004921': {
    dlNo: 'KA13 20170004921',
    doi: '05-05-2017',
    validUptoNT: '04-05-2037',
    validUptoTR: '',
    name: 'HARISHAKUMARA C',
    dob: '24-04-1993',
    bloodGroup: 'O+VE',
    organDonor: 'N',
    swd: 'DHARMEGOWDA',
    address: '#1 KOLAR ROAD, VIJAYAPURA, Bangalore Rural, KA, 562135',
    firstIssueDate: '02-07-2026',
    adpVehNo: '',
    hazardousValidity: '',
    hillValidity: '',
    covList: [
      { covType: 'CAR', code: 'LMV', issuedBy: 'KA51', doi: '18-05-2013', category: 'NT', badgeNo: '', badgeDoi: '', badgeBy: '' }
    ],
    mobileNo: '9876543210',
    rtoAuthority: 'RTO, HASSAN'
  }
};

const CARD_WIDTH = 242.88;
const CARD_HEIGHT = 153.0;

function getTemplatePath(candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(__dirname, 'public', 'assets', 'templates', candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function splitAddress(addr, maxChars = 55) {
  if (!addr || addr.length <= maxChars) return [addr || ''];
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

// Robust Vector PDF Engine with Fallbacks
async function generateA4VectorPDF(report, rcFormat, docType) {
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

  // Draw base background rectangles
  page.drawRectangle({
    x: leftCardX,
    y: cardY,
    width: cardW,
    height: cardH,
    color: rgb(0.98, 0.98, 0.99),
    borderColor: rgb(0.2, 0.25, 0.35),
    borderWidth: 1.5
  });

  page.drawRectangle({
    x: rightCardX,
    y: cardY,
    width: cardW,
    height: cardH,
    color: rgb(0.98, 0.98, 0.99),
    borderColor: rgb(0.2, 0.25, 0.35),
    borderWidth: 1.5
  });

  // Attempt to load and overlay template images if present
  try {
    const roundedMask = Buffer.from(`
      <svg width="1040" height="655">
        <rect x="0" y="0" width="1040" height="655" rx="32" ry="32" fill="#fff"/>
      </svg>
    `);

    const frontPath = getTemplatePath(docType === 'DL' ? ['dl_front.png', 'Website Template Final (13).png'] : ['new_rc_front.png', 'ka_front_hd.png']);
    if (frontPath) {
      const maskedFront = await sharp(frontPath).resize(1040, 655).composite([{ input: roundedMask, blend: 'dest-in' }]).png().toBuffer();
      const frontImg = await pdfDoc.embedPng(maskedFront);
      page.drawImage(frontImg, { x: leftCardX, y: cardY, width: cardW, height: cardH });
    }

    const backPath = getTemplatePath(docType === 'DL' ? ['dl_back.png', 'Website Template Final (14).png'] : ['new_rc_back.png']);
    if (backPath) {
      const maskedBack = await sharp(backPath).resize(1040, 655).composite([{ input: roundedMask, blend: 'dest-in' }]).png().toBuffer();
      const backImg = await pdfDoc.embedPng(maskedBack);
      page.drawImage(backImg, { x: rightCardX, y: cardY, width: cardW, height: cardH });
    }
  } catch (imgErr) {
    console.warn('Template asset optional load skipped:', imgErr.message);
  }

  // Draw Title Bars
  page.drawRectangle({ x: leftCardX, y: cardY + cardH - (22 * S), width: cardW, height: 22 * S, color: rgb(0.12, 0.23, 0.54) });
  page.drawRectangle({ x: rightCardX, y: cardY + cardH - (22 * S), width: cardW, height: 22 * S, color: rgb(0.12, 0.23, 0.54) });

  const titleLeft = docType === 'DL' ? 'DRIVING LICENCE (FORM 7)' : 'CERTIFICATE OF REGISTRATION';
  page.drawText(titleLeft, { x: leftCardX + 10, y: cardY + cardH - (15 * S), size: 7.5 * S, font: fontBold, color: rgb(1, 1, 1) });
  page.drawText('GOVERNMENT OF INDIA', { x: rightCardX + 10, y: cardY + cardH - (15 * S), size: 7.5 * S, font: fontBold, color: rgb(1, 1, 1) });

  // Draw Core Data on Left Card
  const idNo = docType === 'DL' ? (report.dlNo || 'DL-RECORD') : (report.regNo || 'REG-RECORD');
  page.drawText(`ID NO: ${idNo}`, { x: leftCardX + 12, y: cardY + cardH - (38 * S), size: 8 * S, font: fontBold, color: rgb(0, 0, 0) });
  page.drawText(`NAME: ${report.name || report.owner || 'N/A'}`, { x: leftCardX + 12, y: cardY + cardH - (52 * S), size: 6.8 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(`S/W/D: ${report.swd || 'N/A'}`, { x: leftCardX + 12, y: cardY + cardH - (64 * S), size: 6.8 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

  const addrLines = splitAddress(report.address || '', 40);
  addrLines.slice(0, 2).forEach((line, i) => {
    page.drawText(i === 0 ? `ADDR: ${line}` : `      ${line}`, { x: leftCardX + 12, y: cardY + cardH - ((76 + (i * 10)) * S), size: 6.2 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
  });

  // Draw Core Data on Right Card
  if (docType === 'DL') {
    page.drawText(`ISSUE DATE: ${report.doi || '01-01-2020'}`, { x: rightCardX + 12, y: cardY + cardH - (38 * S), size: 6.8 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`VALID (NT): ${report.validUptoNT || '01-01-2035'}`, { x: rightCardX + 12, y: cardY + cardH - (50 * S), size: 6.8 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`AUTHORITY: ${report.rtoAuthority || 'RTO OFFICE'}`, { x: rightCardX + 12, y: cardY + cardH - (62 * S), size: 6.8 * S, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
  } else {
    page.drawText(`MAKER: ${report.maker || 'N/A'}`, { x: rightCardX + 12, y: cardY + cardH - (38 * S), size: 6.5 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`MODEL: ${report.model || 'N/A'}`, { x: rightCardX + 12, y: cardY + cardH - (50 * S), size: 6.5 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`CHASSIS: ${report.chassisNo || 'N/A'}`, { x: rightCardX + 12, y: cardY + cardH - (62 * S), size: 6.5 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`ENGINE: ${report.engineNo || 'N/A'}`, { x: rightCardX + 12, y: cardY + cardH - (74 * S), size: 6.5 * S, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`RTO: ${report.rto || 'RTO OFFICE'}`, { x: rightCardX + 12, y: cardY + cardH - (86 * S), size: 6.8 * S, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
  }

  return await pdfDoc.save();
}

// Main Direct Download Endpoint
app.post('/api/generate-rc-pdf', async (req, res) => {
  try {
    const { vehicleNumber, type, rcFormat } = req.body;
    if (!vehicleNumber) {
      return res.status(400).json({ success: false, message: 'Please provide a registration/DL number.' });
    }

    const cleanInput = vehicleNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const docType = (type === 'operator' || type === 'DL') ? 'DL' : 'RC';
    let report = mockDatabase[cleanInput];

    if (!report) {
      const state = cleanInput.substring(0, 2);
      if (docType === 'DL') {
        report = {
          ...mockDatabase['KA1320170004921'],
          dlNo: vehicleNumber.toUpperCase(),
          rtoAuthority: `${STATE_NAMES[state] || 'STATE'} RTO`
        };
      } else {
        report = {
          ...mockDatabase['KA40EF5093'],
          regNo: vehicleNumber.toUpperCase(),
          rto: `${STATE_NAMES[state] || 'STATE'} RTO`
        };
      }
    }

    const pdfBytes = await generateA4VectorPDF(report, rcFormat || 'NEW', docType);
    const fileName = `${cleanInput}_${docType}_Document.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    console.error('Server PDF Error:', err);
    res.status(500).json({ success: false, message: err.message || 'Internal error creating PDF' });
  }
});

// Fallback Route
// Clean fallback middleware (Supports all Express versions)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Backend running on port ${PORT}`);
});