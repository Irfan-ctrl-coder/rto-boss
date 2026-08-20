const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory order tracking for mock testing
const mockOrders = {};

// Mock Database of Vehicles & DLs
const MOCK_DB = {
  vehicles: {
    'KA01AB1234': {
      regNo: 'KA 01 AB 1234',
      vehicleClass: '2W / MOTORCYCLE',
      is2W: true,
      owner: 'RAHUL SHARMA',
      maker: 'HONDA MOTORCYCLE & SCOOTER INDIA',
      model: 'ACTIVA 6G',
      regDate: '14-Mar-2021',
      fitnessUpto: '13-Mar-2036',
      insuranceUpto: '22-Feb-2027',
      rto: 'KA-01 (KORAMANGALA RTO, BENGALURU)',
      fuel: 'PETROL'
    },
    'KA04MC9999': {
      regNo: 'KA 04 MC 9999',
      vehicleClass: 'LMV / MOTOR CAR (4-WHEELER)',
      is2W: false,
      owner: 'NAGESHA K****',
      maker: 'HYUNDAI MOTOR INDIA LTD',
      model: 'CRETA SX (O)',
      regDate: '19-Jan-2023',
      fitnessUpto: '18-Jan-2038',
      insuranceUpto: '15-Dec-2026',
      rto: 'KA-04 (YESHWANTHPUR RTO, BENGALURU)',
      fuel: 'DIESEL'
    }
  },
  licenses: {
    'DL-1420110012345': {
      dlNo: 'DL-1420110012345',
      name: 'ARJUN VERMA',
      dob: '1995-05-12',
      status: 'ACTIVE / VALID',
      cov: 'MCWG, LMV',
      issueDate: '10-Apr-2011',
      validUpto: '09-Apr-2031',
      rto: 'DL-14 (JANAKPURI RTO, NEW DELHI)'
    }
  }
};

// Endpoint 1: Create Payment Session (Zero API cost)
app.post('/api/create-order', (req, res) => {
  const { docType, targetNumber, tier, amount, dob } = req.body;
  const orderId = 'order_' + Math.random().toString(36).substring(2, 9).toUpperCase();

  mockOrders[orderId] = {
    orderId,
    docType,
    targetNumber: targetNumber.toUpperCase().replace(/\s+/g, ''),
    tier,
    amount: Number(amount),
    dob: dob || null,
    status: 'PAYMENT_PENDING',
    createdAt: new Date().toISOString()
  };

  res.json({
    success: true,
    orderId,
    amount: Number(amount),
    targetNumber
  });
});

// Endpoint 2: Simulate Payment Settlement & Verification
app.post('/api/verify-payment', (req, res) => {
  const { orderId } = req.body;
  const order = mockOrders[orderId];

  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  // RC FLOW
  if (order.docType === 'RC') {
    const reg = order.targetNumber;
    const vehicle = MOCK_DB.vehicles[reg] || {
      regNo: reg,
      vehicleClass: order.tier === '2-Wheeler' ? '2W / MOTORCYCLE' : 'LMV / MOTOR CAR',
      is2W: order.tier === '2-Wheeler',
      owner: 'MOCK REGISTERED OWNER',
      maker: 'TATA MOTORS / BAJAJ AUTO',
      model: 'STANDARD EDITION',
      regDate: '10-Aug-2022',
      fitnessUpto: '09-Aug-2037',
      insuranceUpto: '11-Nov-2026',
      rto: reg.substring(0, 2) + ' RTO CENTRAL AUTHORITY',
      fuel: 'PETROL / HYBRID'
    };

    // Mismatch detection: 2-Wheeler tier purchased for a 4-Wheeler vehicle
    if (order.tier === '2-Wheeler' && !vehicle.is2W) {
      order.status = 'MISMATCH_PAUSED';
      return res.json({
        success: true,
        status: 'MISMATCH_PAUSED',
        message: 'Vehicle category mismatch detected.',
        maskedDetails: {
          regNo: vehicle.regNo,
          owner: vehicle.owner,
          actualClass: vehicle.vehicleClass
        },
        deltaRequired: 300
      });
    }

    // Success
    order.status = 'COMPLETED';
    return res.json({
      success: true,
      status: 'SUCCESS',
      docType: 'RC',
      report: vehicle
    });
  }

  // DL FLOW
  if (order.docType === 'DL') {
    const dlNo = order.targetNumber;
    const license = MOCK_DB.licenses[dlNo] || {
      dlNo: dlNo,
      name: 'VERIFIED CITIZEN',
      dob: order.dob || '1995-01-01',
      status: 'ACTIVE / VALID',
      cov: 'MCWG, LMV',
      issueDate: '15-May-2015',
      validUpto: '14-May-2035',
      rto: 'SARATHI CENTRAL TRANSPORT AUTH'
    };

    order.status = 'COMPLETED';
    return res.json({
      success: true,
      status: 'SUCCESS',
      docType: 'DL',
      report: license
    });
  }
});

// Endpoint 3: Settle Delta Difference for Mismatches
app.post('/api/settle-delta', (req, res) => {
  const { orderId } = req.body;
  const order = mockOrders[orderId];

  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const vehicle = MOCK_DB.vehicles[order.targetNumber] || {
    regNo: order.targetNumber,
    vehicleClass: 'LMV / MOTOR CAR (4-WHEELER)',
    owner: 'NAGESHA KUMAR',
    maker: 'HYUNDAI MOTOR INDIA LTD',
    model: 'CRETA SX (O)',
    regDate: '19-Jan-2023',
    fitnessUpto: '18-Jan-2038',
    insuranceUpto: '15-Dec-2026',
    rto: 'KA-04 (YESHWANTHPUR RTO)',
    fuel: 'DIESEL'
  };

  order.status = 'COMPLETED';
  order.amount += 300;

  res.json({
    success: true,
    status: 'SUCCESS',
    docType: 'RC',
    report: vehicle
  });
});

app.listen(PORT, () => {
  console.log(`⚡ RTO Boss Mock Server live on http://localhost:${PORT}`);
});