/**
 * Fare Validation & Fraud Prevention Routes
 * VeloX Ridez v562
 * 
 * PURPOSE: Server-side verification to prevent:
 *   1. Client-side fare manipulation (rider edits JS to lower fare)
 *   2. Fake balance exploits (rider inflates local balance)
 *   3. Inflated driver cashouts (driver claims more than earned)
 * 
 * ARCHITECTURE: Uses same Prisma + auth middleware as payments.js.
 *   Fare calculation mirrors client-side logic exactly.
 *   All endpoints fail-open: if validation has issues, rides still work.
 * 
 * TEST ACCOUNTS (bypass all validation):
 *   - veloxridez@gmail.com (driver test account)
 *   - smokezempirez@gmail.com (rider test account)
 * 
 * DEPLOYMENT:
 *   1. Copy to src/routes/fare-validation.js
 *   2. In app.js add:
 *        const fareValidation = require('./routes/fare-validation');
 *        app.use('/api', fareValidation);
 *   3. Add balance/walletBalance to Prisma schema (see README)
 *   4. npx prisma db push
 *   5. Push to GitHub — Railway auto-deploys
 */

const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireUserType } = require('../middleware/auth');

// ============================================================
// TEST ACCOUNTS — always bypass validation
// ============================================================
const TEST_EMAILS = [
  'veloxridez@gmail.com',
  'smokezempirez@gmail.com'
];

function isTestEmail(email) {
  return TEST_EMAILS.includes((email || '').toLowerCase());
}

// ============================================================
// PRICING — mirrors client-side SERVICES array exactly
// If you change prices in rider.html, update here too
// ============================================================
const SERVICES = {
  economy:  { base: 5,  mile: 1.50, perMin: 0.20, minimum: 12, hourlyRate: null },
  comfort:  { base: 6,  mile: 1.75, perMin: 0.22, minimum: 15, hourlyRate: null },
  premium:  { base: 8,  mile: 2.00, perMin: 0.25, minimum: 18, hourlyRate: 70 },
  suv:      { base: 10, mile: 2.50, perMin: 0.30, minimum: 25, hourlyRate: 95 },
  luxury:   { base: 12, mile: 3.00, perMin: 0.35, minimum: 35, hourlyRate: 125 },
  xl:       { base: 15, mile: 3.50, perMin: 0.40, minimum: 50, hourlyRate: 175 }
};

const METROS = [
  { lat: 29.42, lng: -98.49, r: 0.6, m: 1.00 },
  { lat: 30.27, lng: -97.74, r: 0.4, m: 1.05 },
  { lat: 29.76, lng: -95.37, r: 0.7, m: 1.10 },
  { lat: 32.78, lng: -96.80, r: 0.7, m: 1.10 },
  { lat: 34.05, lng: -118.24, r: 0.7, m: 1.50 },
  { lat: 37.77, lng: -122.42, r: 0.4, m: 1.55 },
  { lat: 40.71, lng: -74.01, r: 0.4, m: 1.60 },
  { lat: 41.88, lng: -87.63, r: 0.5, m: 1.25 },
  { lat: 25.76, lng: -80.19, r: 0.5, m: 1.25 },
  { lat: 47.61, lng: -122.33, r: 0.4, m: 1.35 },
  { lat: 39.74, lng: -104.99, r: 0.4, m: 1.20 },
  { lat: 33.45, lng: -112.07, r: 0.5, m: 1.10 },
  { lat: 33.75, lng: -84.39, r: 0.5, m: 1.15 },
  { lat: 42.36, lng: -71.06, r: 0.4, m: 1.45 },
  { lat: 38.91, lng: -77.04, r: 0.4, m: 1.40 },
  { lat: 36.17, lng: -115.14, r: 0.4, m: 1.20 }
];

const TAX_RATE = 0.11075;
const FARE_TOLERANCE = 0.15;

// ============================================================
// HELPERS
// ============================================================

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getMultiplier(lat, lng) {
  if (!lat || !lng) return 1.0;
  for (const m of METROS) {
    const d = Math.sqrt((lat - m.lat) ** 2 + (lng - m.lng) ** 2);
    if (d <= m.r) return m.m;
  }
  return 1.0;
}

function serverCalcFare(pickup, dropoff, stops, serviceId, isMember, bookingMode) {
  const svc = SERVICES[serviceId];
  if (!svc) return null;

  const points = [pickup, ...(stops || []), dropoff];
  let dist = 0;
  for (let i = 0; i < points.length - 1; i++) {
    dist += haversine(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
  }

  const duration = Math.ceil(dist * 2.5 + 5);
  const regional = getMultiplier(pickup.lat, pickup.lng);
  const pricing = (!isMember && bookingMode === 'now') ? 2.0 : 1.0;
  const scheduleFee = bookingMode === 'schedule' ? 15.00 : 0;

  const base = (svc.base + (dist * svc.mile) + (duration * svc.perMin)) * regional * pricing;
  const min = (svc.minimum || 12) * regional;
  const subtotal = Math.max(base, min) + scheduleFee;
  const tax = subtotal * TAX_RATE;

  return { total: +(subtotal + tax).toFixed(2), subtotal: +subtotal.toFixed(2) };
}

function serverCalcHourly(serviceId, hours, occasionMult, lat, lng) {
  const svc = SERVICES[serviceId];
  if (!svc || !svc.hourlyRate) return null;

  const regional = getMultiplier(lat, lng);
  const subtotal = svc.hourlyRate * hours * (occasionMult || 1.0) * regional;
  const tax = subtotal * TAX_RATE;

  return { total: +(subtotal + tax).toFixed(2), subtotal: +subtotal.toFixed(2) };
}

// ============================================================
// ROUTE 1: POST /api/validate-fare
// ============================================================
router.post('/validate-fare', requireUserType('user'), asyncHandler(async (req, res) => {
  const { pickup, dropoff, stops, serviceId, clientFare, isMember, bookingMode, hourly } = req.body;

  if (isTestEmail(req.user.email)) {
    return res.json({ valid: true, testMode: true });
  }

  if (!pickup || !pickup.lat || !serviceId || clientFare === undefined) {
    return res.status(400).json({ valid: false, error: 'Missing required fields' });
  }

  let calc;
  if (bookingMode === 'hourly' && hourly) {
    calc = serverCalcHourly(serviceId, hourly.hours, hourly.occasionMultiplier, pickup.lat, pickup.lng);
  } else {
    if (!dropoff || !dropoff.lat) {
      return res.status(400).json({ valid: false, error: 'Missing dropoff' });
    }
    calc = serverCalcFare(pickup, dropoff, stops || [], serviceId, isMember, bookingMode || 'now');
  }

  if (!calc) {
    return res.status(400).json({ valid: false, error: 'Unknown service' });
  }

  const diff = Math.abs(calc.total - clientFare) / Math.max(calc.total, 1);

  if (diff > FARE_TOLERANCE) {
    console.warn(`[FARE MISMATCH] user=${req.user.id} client=$${clientFare} server=$${calc.total} diff=${(diff * 100).toFixed(1)}%`);
    return res.json({ valid: false, error: 'Fare mismatch — please refresh and try again', serverFare: calc.total, clientFare });
  }

  res.json({ valid: true, serverFare: calc.total });
}));

// ============================================================
// ROUTE 2: POST /api/validate-balance
// ============================================================
router.post('/validate-balance', requireUserType('user'), asyncHandler(async (req, res) => {
  const { fare, creditApplied } = req.body;

  if (isTestEmail(req.user.email)) {
    return res.json({ valid: true, testMode: true });
  }

  if (!fare) {
    return res.status(400).json({ valid: false, error: 'Missing fare' });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { balance: true }
  });

  if (!user) {
    return res.status(404).json({ valid: false, error: 'User not found' });
  }

  const amountDue = fare - (creditApplied || 0);
  const balance = user.balance || 0;

  if (balance < amountDue) {
    console.warn(`[BALANCE INSUFFICIENT] user=${req.user.id} balance=$${balance.toFixed(2)} needed=$${amountDue.toFixed(2)}`);
    return res.json({ valid: false, error: 'Insufficient balance', balance: +balance.toFixed(2), required: +amountDue.toFixed(2) });
  }

  res.json({ valid: true, balance: +balance.toFixed(2) });
}));

// ============================================================
// ROUTE 3: POST /api/validate-cashout
// ============================================================
router.post('/validate-cashout', requireUserType('driver'), asyncHandler(async (req, res) => {
  const { amount } = req.body;

  if (isTestEmail(req.user.email)) {
    return res.json({ valid: true, testMode: true });
  }

  if (!amount || amount <= 0) {
    return res.status(400).json({ valid: false, error: 'Invalid amount' });
  }

  const driver = await prisma.driver.findUnique({
    where: { id: req.user.id },
    select: { walletBalance: true }
  });

  if (!driver) {
    return res.status(404).json({ valid: false, error: 'Driver not found' });
  }

  const available = driver.walletBalance || 0;

  if (amount > available + 0.01) {
    console.warn(`[CASHOUT FRAUD] driver=${req.user.id} requested=$${amount} available=$${available.toFixed(2)}`);
    return res.json({ valid: false, error: 'Amount exceeds available balance', requested: amount, available: +available.toFixed(2) });
  }

  res.json({ valid: true, available: +available.toFixed(2) });
}));

module.exports = router;
