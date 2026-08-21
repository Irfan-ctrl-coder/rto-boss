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

// MOCK VEHICLE & DL DATABASE
const MOCK_DB = {
  vehicles: {
    'KA01AB1234': {
      regNo: 'KA 01 AB 1234',
      actualClass: '2-Wheeler',
      standardPrice: 100,
      owner: 'RAHUL SHARMA',
      maker: 'HONDA MOTORCYCLE & SCOOTER INDIA',
      model: 'ACTIVA 6G',
      fuel: 'PETROL',
      regDate: '12-Jan-2021',
      insuranceUpto: '10-Jan-2027',
      fitnessUpto: '11-Jan-2036',
      rto: 'KA-01 (Koramangala, Bangalore Central)'
    },
    'KA04MC9999': {
      regNo: 'KA 04 MC 9999',
      actualClass: '4-Wheeler+',
      standardPrice: 400,
      owner: 'NAGESHA KUMAR',
      maker: 'HYUNDAI MOTOR INDIA LTD',
      model: 'CRETA SX (O) 1.5 DIESEL',
      fuel: 'DIESEL',
      regDate: '18-Aug-2022',
      insuranceUpto: '15-Aug-2026',
      fitnessUpto: '17-Aug-2037',
      rto: 'KA-04 (Yeshwanthpur, Bangalore North)'
    },
    'KA03TR5555': {
      regNo: 'KA 03 TR 5555',
      actualClass: '3-Wheeler',
      standardPrice: 300,
      owner: 'MOHAMMED ISMAIL',
      maker: 'BAJAJ AUTO LTD',
      model: 'COMPACT 4S AUTO RICKSHAW',
      fuel: 'CNG',
      regDate: '05-Mar-2020',
      insuranceUpto: '02-Mar-2027',
      fitnessUpto: '04-Mar-2035',
      rto: 'KA-03 (Indiranagar, Bangalore East)'
    }
  },
  licenses: {
    'DL-1420110012345': {
      dlNo: 'DL-1420110012345',
      name: 'VIKRAM ADITYA SINGH',
      dob: '1995-05-12',
      status: 'ACTIVE / VALID',
      cov: 'MCWG, LMV (Motorcycle with Gear, Light Motor Vehicle)',
      issueDate: '14-Apr-2011',
      validUpto: '13-Apr-2035',
      rto: 'DL-14 (Janakpuri, Delhi West)'
    }
  }
};

// IN-MEMORY ACTIVE SESSIONS
const ACTIVE_ORDERS = new Map();

// 1. CREATE ORDER ENDPOINT (With Pre-Payment Class Matching)
app.post('/api/create-order', (req, res) => {
  const { docType, targetNumber, tier, amount, dob } = req.body;
  const cleanTarget = (targetNumber || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

  if (!cleanTarget) {
    return res.status(400).json({ error: 'Target Number is required' });
  }

  const orderId = 'ORD_' + Math.random().toString(36).substring(2, 9).toUpperCase();

  let finalAmount = amount;
  let detectedActualClass = tier;
  let priceAdjusted = false;

  // IF RC: Check vehicle class before order creation to prevent overcharge
  if (docType === 'RC') {
    const knownVehicle = MOCK_DB.vehicles[cleanTarget];
    
    if (knownVehicle) {
      detectedActualClass = knownVehicle.actualClass;
      const truePrice = knownVehicle.standardPrice;

      // Overpayment Correction: If user selected a higher tier for a cheaper vehicle, force true price
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
    priceAdjusted,
    paid: false,
    dob
  });

  return res.json({
    success: true,
    orderId,
    amount: finalAmount,
    priceAdjusted,
    message: priceAdjusted ? `Vehicle auto-detected as ${detectedActualClass}. Price optimized to ₹${finalAmount}.` : 'Order created successfully'
  });
});

// 2. VERIFY PAYMENT ENDPOINT (Enforcing True Tier Protection)
app.post('/api/verify-payment', (req, res) => {
  const { orderId } = req.body;
  const order = ACTIVE_ORDERS.get(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  order.paid = true;

  // DL VERIFICATION FLOW
  if (order.docType === 'DL') {
    const dlData = MOCK_DB.licenses[order.targetNumber] || {
      dlNo: order.targetNumber,
      name: 'AUTHORIZED HOLDER',
      dob: order.dob || '1990-01-01',
      status: 'ACTIVE / VALID',
      cov: 'MCWG, LMV',
      issueDate: '01-Jan-2015',
      validUpto: '01-Jan-2035',
      rto: 'Regional Transport Authority'
    };

    return res.json({ status: 'SUCCESS', docType: 'DL', report: dlData });
  }

  // RC VERIFICATION FLOW
  const vehicle = MOCK_DB.vehicles[order.targetNumber] || {
    regNo: order.targetNumber,
    actualClass: order.selectedTier,
    standardPrice: TIER_PRICES[order.selectedTier] || 100,
    owner: 'REGISTERED CITIZEN',
    maker: 'BAJAJ / HERO / HONDA',
    model: 'COMMUTER CLASS',
    fuel: 'PETROL',
    regDate: '10-Oct-2020',
    insuranceUpto: '09-Oct-2027',
    fitnessUpto: '09-Oct-2035',
    rto: 'State Transport Department'
  };

  // CHECK FOR UNDERPAYMENT MISMATCH (e.g. Paid ₹100 for a 4-Wheeler Car)
  if (order.amountBilled < vehicle.standardPrice) {
    const deltaDue = vehicle.standardPrice - order.amountBilled;
    
    return res.json({
      status: 'MISMATCH_PAUSED',
      deltaDue,
      maskedDetails: {
        regNo: vehicle.regNo,
        owner: maskName(vehicle.owner),
        actualClass: vehicle.actualClass,
        selectedClass: order.selectedTier
      }
    });
  }

  // COMPLETE SUCCESS
  return res.json({
    status: 'SUCCESS',
    docType: 'RC',
    report: vehicle
  });
});

// 3. SETTLE DELTA BALANCE ENDPOINT
app.post('/api/settle-delta', (req, res) => {
  const { orderId } = req.body;
  const order = ACTIVE_ORDERS.get(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const vehicle = MOCK_DB.vehicles[order.targetNumber];
  order.amountBilled = vehicle.standardPrice;

  return res.json({
    status: 'SUCCESS',
    docType: 'RC',
    report: vehicle
  });
});

function maskName(name) {
  if (!name) return 'N/A';
  return name.split(' ').map(part => {
    if (part.length <= 2) return part;
    return part[0] + '*'.repeat(part.length - 2) + part[part.length - 1];
  }).join(' ');
}

app.listen(PORT, () => {
  console.log(`RTO Boss Server running securely on http://localhost:${PORT}`);
});