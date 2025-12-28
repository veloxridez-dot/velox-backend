/**
 * Admin Routes
 * Dashboard, driver management, analytics
 */

const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateAdmin } = require('../middleware/auth');

// Simple admin auth for demo (in production, use proper admin system)
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  // Demo admin credentials (replace with proper auth in production)
  if (email === 'admin@velox.com' && password === 'velox-admin-2024') {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { id: 'admin-1', type: 'admin', email, role: 'super_admin' },
      process.env.JWT_SECRET,
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
  
  const where = status ? { status } : {};
  
  const [drivers, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
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
router.post('/drivers/:id/status', authenticateAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body; // APPROVED, REJECTED, SUSPENDED
  
  const updateData = { status };
  if (status === 'APPROVED') updateData.approvedAt = new Date();
  
  await prisma.driver.update({ where: { id }, data: updateData });
  
  // TODO: Send notification to driver
  
  res.json({ success: true, status });
}));

// Get all rides
router.get('/rides', authenticateAdmin, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  
  const where = status ? { status } : {};
  
  const [rides, total] = await Promise.all([
    prisma.ride.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
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

router.post('/promos', authenticateAdmin, asyncHandler(async (req, res) => {
  const { code, type, value, maxDiscount, usageLimit, validUntil } = req.body;
  
  const promo = await prisma.promoCode.create({
    data: {
      code: code.toUpperCase(),
      type,
      value,
      maxDiscount,
      usageLimit,
      validUntil: validUntil ? new Date(validUntil) : null
    }
  });
  
  res.json({ success: true, promo });
}));

module.exports = router;
