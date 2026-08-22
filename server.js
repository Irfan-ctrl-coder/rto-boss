const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PRICING MATRIX
const TIER_PRICES = {
  '2-Wheeler': 100,
  '3-Wheeler': 300,
  '4-Wheeler+': 400
};

// FULL STATE NAME MAP
const STATE_NAMES = {
  'KA': 'KARNATAKA',
  'TN': 'TAMIL NADU',
  'MH': 'MAHARASHTRA',
  'DL': 'DELHI',
  'KL': 'KERALA',
  'AP': 'ANDHRA PRADESH',
  'TS': 'TELANGANA',
  'UP': 'UTTAR PRADESH',
  'GJ': 'GUJARAT',
  'RJ': 'RAJASTHAN',
  'WB': 'WEST BENGAL',
  'MP': 'MADHYA PRADESH',
  'HR': 'HARYANA',
  'PB': 'PUNJAB'
};

// VEHICLE DATABASE (HARDCODED REFERENCE & EXTENSIBLE FOR API)
const MOCK_DB = {
  vehicles: {
    // 1. Karnataka Old RC Sample
    'KA09HJ1161': {
      regNo: 'KA09HJ1161',
      state: 'KA',
      actualClass: '2-Wheeler',
      vehicleClassFull: 'M-Cycle/Scooter(2WN)',
      standardPrice: 100,
      owner: 'JYOTHI M',
      swd: 'NAGAVENI',
      address: '# 956, BEML LAYOUT,, 2ND STAGE, RAJARAJESHWARI NAGAR,, MYSORE, -570022',
      maker: 'HONDA MOTORCYCLE AND SCOOTER INDIA (P) LTD',
      model: 'H ACTIVA 3G CBS BS3',
      color: 'WHITE',
      bodyType: 'U BONE',
      fuel: 'PETROL',
      norms: 'BHARAT STAGE III',
      regDate: '06-07-2016',
      validUpto: '05-07-2031',
      cardIssueDate: '06-07-2016',
      ownerSerial: '01',
      chassisNo: 'ME4JF505FGT539299',
      engineNo: 'JF50ET3541017',
      seating: '2',
      standing: '0',
      sleeper: '0',
      unladenWt: '108',
      ladenWt: '240',
      grossWt: '240',
      cubicCap: '109.00',
      hp: '',
      wheelBase: '0',
      mfgDate: '7/2016',
      cylinders: '1',
      axles: '1',
      stdgSlpr: '0 / 0',
      taxUpto: 'LTT',
      financer: '',
      rtaRef: '',
      rto: 'MYSURU WEST RTO'
    },
    // 2. Karnataka Old Reference Sample 2
    'KA03HZ2486': {
      regNo: 'KA03HZ2486',
      state: 'KA',
      actualClass: '2-Wheeler',
      vehicleClassFull: 'M-Cycle/Scooter',
      standardPrice: 100,
      owner: 'RAJU B',
      swd: 'BYATA VENKATAPPA',
      address: '# 20-A ULLITHIGALARA BEEDI,ANEKAL TOWN,BENGALURU WEF-2-2-16,Karnataka,562106',
      maker: 'BAJAJ AUTO LTD',
      model: 'PULSAR 150 DTS I (UG 4.5)',
      color: 'C WINE RED',
      bodyType: 'SOLO WITH PI',
      fuel: 'PETROL',
      norms: 'BHARAT STAGE III',
      regDate: '23-Apr-2015',
      validUpto: '22-Apr-2030',
      cardIssueDate: '23-Apr-2015',
      ownerSerial: '02',
      chassisNo: 'MD2A11CZ3FWM15704',
      engineNo: 'DHZWFM93243',
      seating: '02',
      standing: '0',
      sleeper: '0',
      unladenWt: '143',
      ladenWt: '',
      grossWt: '',
      cubicCap: '149.00',
      hp: '',
      wheelBase: '1320',
      mfgDate: '3 / 2015',
      cylinders: '01',
      axles: '1',
      stdgSlpr: '0/0',
      taxUpto: 'LTT',
      financer: '',
      rtaRef: '',
      rto: 'BENGALURU WEST RTO'
    },
    // 3. Karnataka Smart Card Sample
    'KA40Y5748': {
      regNo: 'KA40Y5748',
      state: 'KA',
      actualClass: '2-Wheeler',
      vehicleClassFull: 'M-Cycle/Scooter (2WN)',
      standardPrice: 100,
      owner: 'MUNIRATNA M',
      swd: 'MANJUNATHA H',
      address: '#53 KODIHALLI KONAGHATTA POST, DODDABALLAPUR TALUK,, Bangalore Rural, KA, 561203',
      maker: 'HERO MOTOCORP LTD',
      model: 'MAESTRO EDGE',
      color: 'PSM',
      bodyType: 'SOLO',
      fuel: 'PETROL',
      norms: 'BHARAT STAGE III',
      regDate: '08-08-2016',
      validUpto: '07-08-2031',
      cardIssueDate: '06-06-2026',
      ownerSerial: '02',
      chassisNo: 'MBLJF33AAG4C00889',
      engineNo: 'JF33AAG4C00962',
      seating: '2',
      standing: '1',
      sleeper: '',
      unladenWt: '110',
      ladenWt: '240',
      grossWt: '240',
      cubicCap: '111',
      hp: '',
      wheelBase: '1261',
      mfgDate: '03-2016',
      cylinders: '1',
      axles: '1',
      stdgSlpr: '0 / 0',
      taxUpto: 'LTT',
      financer: '',
      rtaRef: 'RTA11313983',
      rto: 'CHICKABALLAPUR RTO'
    }
  },
  licenses: {
    'KA1120140002551': {
      dlNo: 'KA11 20140002551',
      state: 'KA',
      name: 'VIJAYAKUMAR K J',
      dob: '06-02-1982',
      bloodGroup: '',
      organDonor: '',
      swd: 'JAVAREGOWDA',
      address: '#47,KALENAHALLI, P PURA TQ, MANDYA DT, 571401',
      issueDate: '03-03-2014',
      validityNT: '05-02-2032',
      validityTR: '',
      firstIssue: '03-03-2014',
      status: 'ACTIVE / VALID',
      rto: 'RTO,MANDYA',
      covs: [
        { code: 'MCWG', issuedBy: 'KA11', date: '03-03-2014', category: 'NT', type: 'bike' },
        { code: 'LMV', issuedBy: 'KA11', date: '03-03-2014', category: 'NT', type: 'car' }
      ]
    }
  }
};

const ACTIVE_ORDERS = new Map();

// 1. CREATE ORDER ENDPOINT
app.post('/api/create-order', (req, res) => {
  const { docType, targetNumber, tier, amount, dob, rcFormat } = req.body;
  const cleanTarget = (targetNumber || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

  if (!cleanTarget) {
    return res.status(400).json({ error: 'Identifier is required' });
  }

  const stateCode = cleanTarget.substring(0, 2);
  const orderId = 'ORD_' + Math.random().toString(36).substring(2, 9).toUpperCase();

  let finalAmount = amount;
  let detectedActualClass = tier;
  let priceAdjusted = false;

  if (docType === 'RC') {
    const knownVehicle = MOCK_DB.vehicles[cleanTarget];
    if (knownVehicle) {
      detectedActualClass = knownVehicle.actualClass;
      const truePrice = knownVehicle.standardPrice;
      if (amount > truePrice) {
        finalAmount = truePrice;
        priceAdjusted = true;
      }
    }
  }

  ACTIVE_ORDERS.set(orderId, {
    orderId,
    docType,
    targetNumber: cleanTarget,
    selectedTier: tier,
    actualClass: detectedActualClass,
    amountBilled: finalAmount,
    stateCode,
    rcFormat: rcFormat || 'OLD',
    priceAdjusted,
    paid: false,
    dob
  });

  return res.json({
    success: true,
    orderId,
    amount: finalAmount,
    stateCode,
    rcFormat: rcFormat || 'OLD',
    priceAdjusted
  });
});

// 2. VERIFY PAYMENT & RETURN VEHICLE RECORD
app.post('/api/verify-payment', (req, res) => {
  const { orderId } = req.body;
  const order = ACTIVE_ORDERS.get(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  order.paid = true;

  // DL FLOW
  if (order.docType === 'DL') {
    const dlData = MOCK_DB.licenses[order.targetNumber] || {
      dlNo: order.targetNumber,
      state: order.stateCode,
      name: 'AUTHORISED CITIZEN HOLDER',
      dob: order.dob || '01-01-1990',
      bloodGroup: '',
      organDonor: '',
      swd: 'GUARDIAN NAME',
      address: `RESIDENTIAL RECORD ADDRESS, ${order.stateCode}, INDIA`,
      issueDate: '01-01-2015',
      validityNT: '01-01-2035',
      validityTR: '',
      firstIssue: '01-01-2015',
      status: 'ACTIVE / VALID',
      rto: `RTO, ${STATE_NAMES[order.stateCode] || 'CENTRAL'}`,
      covs: [
        { code: 'MCWG', issuedBy: order.stateCode + '01', date: '01-01-2015', category: 'NT', type: 'bike' },
        { code: 'LMV', issuedBy: order.stateCode + '01', date: '01-01-2015', category: 'NT', type: 'car' }
      ]
    };

    return res.json({
      status: 'SUCCESS',
      docType: 'DL',
      stateCode: order.stateCode,
      stateName: STATE_NAMES[order.stateCode] || 'KARNATAKA',
      report: dlData
    });
  }

  // RC FLOW
  const state = order.targetNumber.substring(0, 2);
  const vehicle = MOCK_DB.vehicles[order.targetNumber] || {
    regNo: order.targetNumber,
    state: state,
    actualClass: order.selectedTier,
    vehicleClassFull: order.selectedTier === '2-Wheeler' ? 'M-Cycle/Scooter(2WN)' : 'LMV (Motor Car)',
    standardPrice: TIER_PRICES[order.selectedTier] || 100,
    owner: 'REGISTERED CITIZEN',
    swd: 'GUARDIAN / SPOUSE',
    address: `#100, 1ST MAIN ROAD, RAJAJINAGAR, BANGALORE, -560010`,
    maker: 'HONDA MOTORCYCLE AND SCOOTER INDIA (P) LTD',
    model: 'H ACTIVA 3G CBS BS3',
    color: 'WHITE',
    bodyType: 'U BONE',
    fuel: 'PETROL',
    norms: 'BHARAT STAGE III',
    regDate: '06-07-2016',
    validUpto: '05-07-2031',
    cardIssueDate: '06-07-2016',
    ownerSerial: '01',
    chassisNo: 'ME4JF505FGT' + Math.floor(100000 + Math.random() * 900000),
    engineNo: 'JF50ET' + Math.floor(1000000 + Math.random() * 9000000),
    seating: '2',
    standing: '0',
    sleeper: '0',
    unladenWt: '108',
    ladenWt: '240',
    grossWt: '240',
    cubicCap: '109.00',
    hp: '',
    wheelBase: '0',
    mfgDate: '7/2016',
    cylinders: '1',
    axles: '1',
    stdgSlpr: '0 / 0',
    taxUpto: 'LTT',
    financer: '',
    rtaRef: '',
    rto: `${state} RTO OFFICE`
  };

  return res.json({
    status: 'SUCCESS',
    docType: 'RC',
    rcFormat: order.rcFormat,
    stateCode: order.stateCode,
    stateName: STATE_NAMES[order.stateCode] || 'KARNATAKA',
    report: vehicle
  });
});

app.listen(PORT, () => {
  console.log(`Server live on http://localhost:${PORT}`);
});