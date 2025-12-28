/**
 * Driver Routes
 * Profile, earnings, status, location
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken, requireUserType } = require('../middleware/auth');

// Get driver profile (authenticated)
router.get('/me', authenticateToken, requireUserType('driver'), asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({
    where: { id: req.user.id },
    include: { payoutMethods: { select: { id: true, type: true, bankName: true, last4: true, isDefault: true } } }
  });
  
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  
  // Get today's earnings
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayEarnings = await prisma.earning.aggregate({
    where: { driverId: req.user.id, createdAt: { gte: today } },
    _sum: { netAmount: true, tip: true }
  });
  
  res.json({
    id: driver.id,
    email: driver.email,
    phone: driver.phone,
    firstName: driver.firstName,
    lastName: driver.lastName,
    rating: driver.rating,
    totalRides: driver.totalRides,
    totalEarnings: parseFloat(driver.totalEarnings),
    todayEarnings: parseFloat(todayEarnings._sum.netAmount || 0) + parseFloat(todayEarnings._sum.tip || 0),
    vehicle: {
      make: driver.vehicleMake,
      model: driver.vehicleModel,
      year: driver.vehicleYear,
      color: driver.vehicleColor,
      plate: driver.licensePlate
    },
    status: driver.status,
    isOnline: driver.isOnline,
    stripeOnboarded: driver.stripeOnboarded,
    payoutMethods: driver.payoutMethods
  });
}));

// Update driver location
router.post('/location', authenticateToken, requireUserType('driver'),
  body('lat').isFloat(),
  body('lng').isFloat(),
  asyncHandler(async (req, res) => {
    const { lat, lng } = req.body;
    
    await prisma.driver.update({
      where: { id: req.user.id },
      data: { currentLat: lat, currentLng: lng, lastLocationUpdate: new Date() }
    });
    
    await redis.updateDriverLocation(req.user.id, lat, lng);
    res.json({ success: true });
  })
);

// Go online/offline
router.post('/status', authenticateToken, requireUserType('driver'),
  body('online').isBoolean(),
  asyncHandler(async (req, res) => {
    const { online, lat, lng } = req.body;
    
    await prisma.driver.update({
      where: { id: req.user.id },
      data: { 
        isOnline: online,
        ...(lat && lng ? { currentLat: lat, currentLng: lng, lastLocationUpdate: new Date() } : {})
      }
    });
    
    if (online && lat && lng) {
      await redis.updateDriverLocation(req.user.id, lat, lng);
    } else {
      await redis.removeDriverFromPool(req.user.id);
    }
    
    res.json({ success: true, online });
  })
);

// Get earnings history
router.get('/earnings', authenticateToken, requireUserType('driver'), asyncHandler(async (req, res) => {
  const { period = 'week', limit = 50 } = req.query;
  
  let startDate = new Date();
  if (period === 'day') startDate.setDate(startDate.getDate() - 1);
  else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
  else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
  
  const earnings = await prisma.earning.findMany({
    where: { driverId: req.user.id, createdAt: { gte: startDate } },
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit),
    include: { ride: { select: { pickupAddress: true, dropoffAddress: true, completedAt: true } } }
  });
  
  const totals = await prisma.earning.aggregate({
    where: { driverId: req.user.id, createdAt: { gte: startDate } },
    _sum: { netAmount: true, tip: true },
    _count: true
  });
  
  res.json({
    earnings: earnings.map(e => ({
      id: e.id,
      amount: parseFloat(e.netAmount),
      tip: parseFloat(e.tip),
      total: parseFloat(e.netAmount) + parseFloat(e.tip),
      status: e.status,
      date: e.createdAt,
      ride: e.ride ? { pickup: e.ride.pickupAddress, dropoff: e.ride.dropoffAddress, completedAt: e.ride.completedAt } : null
    })),
    summary: {
      totalEarnings: parseFloat(totals._sum.netAmount || 0),
      totalTips: parseFloat(totals._sum.tip || 0),
      rideCount: totals._count,
      period
    }
  });
}));

// Get available ride requests (for polling if not using sockets)
router.get('/requests', authenticateToken, requireUserType('driver'), asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.user.id } });
  
  if (!driver.isOnline) {
    return res.json({ requests: [] });
  }
  
  // Find rides near driver
  const nearbyRequests = await redis.findNearbyDrivers(driver.currentLat, driver.currentLng, 10);
  
  const rides = await prisma.ride.findMany({
    where: {
      status: 'REQUESTED',
      serviceType: { in: driver.serviceTypes },
      requestedAt: { gte: new Date(Date.now() - 60000) } // Last 60 seconds
    },
    orderBy: { requestedAt: 'desc' },
    take: 5
  });
  
  res.json({
    requests: rides.map(r => ({
      id: r.id,
      pickup: { address: r.pickupAddress, lat: r.pickupLat, lng: r.pickupLng },
      dropoff: { address: r.dropoffAddress, lat: r.dropoffLat, lng: r.dropoffLng },
      serviceType: r.serviceType,
      fare: parseFloat(r.driverEarnings),
      distance: r.distanceMiles,
      requestedAt: r.requestedAt
    }))
  });
}));

module.exports = router;
