/**
 * Admin Routes
 * Dashboard, driver management, analytics
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateAdmin } = require('../middleware/auth');
const { safeCompare, getJwtSecret } = require('../config/security');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

function parsePagination(limit, offset) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);

  return {
    limit: Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100),
    offset: Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0)
  };
}

router.post('/login',
  adminLoginLimiter,
  body('email').isEmail().withMessage('Valid admin email is required'),
  body('password').isString().isLength({ min: 1, max: 256 }).withMessage('Password is required'),
  asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;
  const configuredEmail = process.env.ADMIN_EMAIL;
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const configuredPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!configuredEmail || (!configuredPassword && !configuredPasswordHash)) {
    return res.status(503).json({
      error: 'Admin authentication is not configured'
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const expectedEmail = configuredEmail.trim().toLowerCase();
  const emailMatches = safeCompare(normalizedEmail, expectedEmail);

  let passwordMatches = false;
  if (configuredPasswordHash) {
    passwordMatches = await bcrypt.compare(password, configuredPasswordHash).catch(() => false);
  }
  if (!passwordMatches && configuredPassword) {
    passwordMatches = safeCompare(password, configuredPassword);
  }

  if (emailMatches && passwordMatches) {
    const token = jwt.sign(
      { id: 'admin-1', type: 'admin', email: expectedEmail, role: 'super_admin' },
      getJwtSecret(),
      { expiresIn: '24h' }
    );
    return res.json({ success: true, token });
  }

  res.status(401).json({ error: 'Invalid credentials' });
}));

// Dashboard stats
router.get('/stats', authenticateAdmin, asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const [
    totalRiders,
    totalDrivers,
    activeDrivers,
    todayRides,
    todayRevenue,
    pendingDrivers
  ] = await Promise.all([
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.driver.count({ where: { status: 'APPROVED' } }),
    prisma.driver.count({ where: { isOnline: true, status: 'APPROVED' } }),
    prisma.ride.count({ where: { createdAt: { gte: today } } }),
    prisma.ride.aggregate({
      where: { status: 'COMPLETED', completedAt: { gte: today } },
      _sum: { platformFee: true }
    }),
    prisma.driver.count({ where: { status: 'PENDING_APPROVAL' } })
  ]);
  
  res.json({
    totalRiders,
    totalDrivers,
    activeDrivers,
    todayRides,
    todayRevenue: parseFloat(todayRevenue._sum.platformFee || 0),
    pendingDrivers
  });
}));

// Get all drivers
router.get('/drivers', authenticateAdmin, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const pagination = parsePagination(limit, offset);
  
  const where = status ? { status } : {};
  
  const [drivers, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: pagination.limit,
      skip: pagination.offset,
      select: {
        id: true, email: true, phone: true, firstName: true, lastName: true,
        rating: true, totalRides: true, status: true, isOnline: true,
        vehicleMake: true, vehicleModel: true, licensePlate: true,
        createdAt: true, approvedAt: true
      }
    }),
    prisma.driver.count({ where })
  ]);
  
  res.json({ drivers, total });
}));

// Approve/reject driver
router.post('/drivers/:id/status', authenticateAdmin,
  param('id').isUUID(),
  body('status').isIn(['APPROVED', 'REJECTED', 'SUSPENDED']).withMessage('Invalid status'),
  body('reason').optional().isString().isLength({ max: 1000 }),
  asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { status, reason } = req.body; // APPROVED, REJECTED, SUSPENDED

  if ((status === 'REJECTED' || status === 'SUSPENDED') && !reason) {
    return res.status(400).json({ error: 'A reason is required for rejected or suspended drivers' });
  }

  const updateData = { status };
  if (status === 'APPROVED') updateData.approvedAt = new Date();
  
  await prisma.driver.update({ where: { id }, data: updateData });
  
  // TODO: Send notification to driver
  
  res.json({ success: true, status });
}));

// Get all rides
router.get('/rides', authenticateAdmin, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const pagination = parsePagination(limit, offset);
  
  const where = status ? { status } : {};
  
  const [rides, total] = await Promise.all([
    prisma.ride.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: pagination.limit,
      skip: pagination.offset,
      include: {
        user: { select: { firstName: true, lastName: true } },
        driver: { select: { firstName: true, lastName: true } }
      }
    }),
    prisma.ride.count({ where })
  ]);
  
  res.json({
    rides: rides.map(r => ({
      id: r.id,
      status: r.status,
      pickup: r.pickupAddress,
      dropoff: r.dropoffAddress,
      fare: parseFloat(r.totalFare),
      platformFee: parseFloat(r.platformFee),
      rider: r.user ? `${r.user.firstName} ${r.user.lastName}` : null,
      driver: r.driver ? `${r.driver.firstName} ${r.driver.lastName}` : null,
      createdAt: r.createdAt
    })),
    total
  });
}));

// Get live driver locations
router.get('/drivers/live', authenticateAdmin, asyncHandler(async (req, res) => {
  const onlineDrivers = await redis.getAllOnlineDrivers();
  
  // Get driver details
  const driverIds = onlineDrivers.map(d => d.driverId);
  const drivers = await prisma.driver.findMany({
    where: { id: { in: driverIds } },
    select: { id: true, firstName: true, lastName: true, vehicleMake: true, vehicleModel: true }
  });
  
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  
  res.json({
    drivers: onlineDrivers.map(d => ({
      ...d,
      name: driverMap.get(d.driverId)?.firstName || 'Unknown',
      vehicle: driverMap.get(d.driverId) ? `${driverMap.get(d.driverId).vehicleMake} ${driverMap.get(d.driverId).vehicleModel}` : null
    }))
  });
}));

// Promo codes management
router.get('/promos', authenticateAdmin, asyncHandler(async (req, res) => {
  const promos = await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ promos });
}));

router.post('/promos', authenticateAdmin,
  body('code').isString().trim().isLength({ min: 3, max: 32 }),
  body('type').isIn(['FIXED', 'PERCENTAGE']),
  body('value').isFloat({ gt: 0 }),
  body('maxDiscount').optional().isFloat({ gt: 0 }),
  body('usageLimit').optional().isInt({ gt: 0 }),
  body('validUntil').optional().isISO8601(),
  asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { code, type, value, maxDiscount, usageLimit, validUntil } = req.body;
  
  const promo = await prisma.promoCode.create({
    data: {
      code: code.toUpperCase(),
      type,
      value: Number(value),
      maxDiscount: maxDiscount !== undefined ? Number(maxDiscount) : null,
      usageLimit: usageLimit !== undefined ? Number.parseInt(usageLimit, 10) : null,
      validUntil: validUntil ? new Date(validUntil) : null
    }
  });
  
  res.json({ success: true, promo });
}));

module.exports = router;
