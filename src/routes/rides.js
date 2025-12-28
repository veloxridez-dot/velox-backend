/**
 * Rides Routes
 * Core ride booking, matching, and tracking functionality
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireUserType } = require('../middleware/auth');
const { calculateFare, calculateDistance } = require('../utils/pricing');

// ===========================================
// GET FARE ESTIMATE
// ===========================================

/**
 * POST /api/rides/estimate
 * Get fare estimate for a ride
 */
router.post('/estimate',
  body('pickupLat').isFloat(),
  body('pickupLng').isFloat(),
  body('dropoffLat').isFloat(),
  body('dropoffLng').isFloat(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { pickupLat, pickupLng, dropoffLat, dropoffLng, stops = [] } = req.body;

    // Calculate distance (including stops)
    let totalDistance = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
    let totalDuration = Math.ceil(totalDistance * 2.5 + 5); // Rough estimate: 2.5 min/mile + 5 min buffer

    // Add stop distances
    if (stops.length > 0) {
      let prevLat = pickupLat, prevLng = pickupLng;
      for (const stop of stops) {
        totalDistance += calculateDistance(prevLat, prevLng, stop.lat, stop.lng);
        prevLat = stop.lat;
        prevLng = stop.lng;
      }
      totalDistance += calculateDistance(prevLat, prevLng, dropoffLat, dropoffLng);
      totalDuration += stops.length * 3; // 3 min per stop
    }

    // Get surge multiplier (placeholder - would check demand in production)
    const surgeMultiplier = 1.0; // TODO: Implement dynamic surge pricing

    // Calculate fares for each service type
    const estimates = {};
    const serviceTypes = ['VELOX', 'VELOX_XL', 'VELOX_BLACK', 'VELOX_GREEN'];

    for (const serviceType of serviceTypes) {
      const fare = calculateFare(totalDistance, totalDuration, serviceType, surgeMultiplier);
      
      // Check driver availability
      const nearbyDrivers = await redis.findNearbyDrivers(pickupLat, pickupLng, 10);
      const availableDrivers = await getAvailableDriversForService(nearbyDrivers, serviceType);
      
      estimates[serviceType] = {
        ...fare,
        distanceMiles: Math.round(totalDistance * 10) / 10,
        durationMinutes: totalDuration,
        surgeMultiplier,
        driversAvailable: availableDrivers.length,
        eta: availableDrivers.length > 0 
          ? Math.ceil(availableDrivers[0].distanceMiles * 3) // ~3 min per mile
          : null
      };
    }

    res.json({
      estimates,
      pickup: { lat: pickupLat, lng: pickupLng },
      dropoff: { lat: dropoffLat, lng: dropoffLng },
      stops
    });
  })
);

// ===========================================
// REQUEST RIDE
// ===========================================

/**
 * POST /api/rides/request
 * Request a new ride
 */
router.post('/request',
  requireUserType('user'),
  body('pickupAddress').notEmpty(),
  body('pickupLat').isFloat(),
  body('pickupLng').isFloat(),
  body('dropoffAddress').notEmpty(),
  body('dropoffLat').isFloat(),
  body('dropoffLng').isFloat(),
  body('serviceType').isIn(['VELOX', 'VELOX_XL', 'VELOX_BLACK', 'VELOX_GREEN']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const {
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      serviceType, stops = [], paymentMethodId,
      scheduledFor, promoCode
    } = req.body;

    // Check for active ride
    const activeRide = await prisma.ride.findFirst({
      where: {
        userId,
        status: { in: ['REQUESTED', 'ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS'] }
      }
    });

    if (activeRide) {
      return res.status(400).json({ error: 'You already have an active ride' });
    }

    // Calculate fare
    const distance = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
    const duration = Math.ceil(distance * 2.5 + 5);
    const surgeMultiplier = 1.0; // TODO: Dynamic surge
    const fareDetails = calculateFare(distance, duration, serviceType, surgeMultiplier);

    // Apply promo code if provided
    let promoDiscount = 0;
    if (promoCode) {
      const promo = await validatePromoCode(promoCode, userId, fareDetails.totalFare);
      if (promo.valid) {
        promoDiscount = promo.discount;
      }
    }

    // Calculate platform fee and driver earnings
    const platformFeePercent = 20; // 20% platform fee
    const totalFare = fareDetails.totalFare - promoDiscount;
    const platformFee = totalFare * (platformFeePercent / 100);
    const driverEarnings = totalFare - platformFee;

    // Create ride
    const ride = await prisma.ride.create({
      data: {
        userId,
        pickupAddress,
        pickupLat,
        pickupLng,
        dropoffAddress,
        dropoffLat,
        dropoffLng,
        distanceMiles: distance,
        durationMinutes: duration,
        serviceType,
        baseFare: fareDetails.baseFare,
        distanceFare: fareDetails.distanceFare,
        timeFare: fareDetails.timeFare,
        surgeMult: surgeMultiplier,
        promoDiscount,
        totalFare,
        platformFee,
        driverEarnings,
        paymentMethodId,
        isScheduled: !!scheduledFor,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        status: scheduledFor ? 'REQUESTED' : 'REQUESTED',
        stops: {
          create: stops.map((stop, index) => ({
            address: stop.address,
            latitude: stop.lat,
            longitude: stop.lng,
            order: index + 1
          }))
        }
      },
      include: {
        stops: true
      }
    });

    // Store ride state in Redis for real-time access
    await redis.setRideState(ride.id, {
      id: ride.id,
      userId,
      status: ride.status,
      pickup: { address: pickupAddress, lat: pickupLat, lng: pickupLng },
      dropoff: { address: dropoffAddress, lat: dropoffLat, lng: dropoffLng },
      serviceType,
      totalFare: parseFloat(totalFare),
      createdAt: ride.createdAt
    });

    // If not scheduled, start driver matching
    if (!scheduledFor) {
      // Emit to socket for real-time updates
      const io = req.app.get('io');
      startDriverMatching(ride.id, io);
    }

    res.status(201).json({
      success: true,
      ride: {
        id: ride.id,
        status: ride.status,
        pickup: { address: pickupAddress, lat: pickupLat, lng: pickupLng },
        dropoff: { address: dropoffAddress, lat: dropoffLat, lng: dropoffLng },
        stops: ride.stops,
        serviceType,
        fare: {
          base: parseFloat(fareDetails.baseFare),
          distance: parseFloat(fareDetails.distanceFare),
          time: parseFloat(fareDetails.timeFare),
          surge: surgeMultiplier,
          promoDiscount: parseFloat(promoDiscount),
          total: parseFloat(totalFare)
        },
        distanceMiles: distance,
        durationMinutes: duration,
        isScheduled: ride.isScheduled,
        scheduledFor: ride.scheduledFor
      }
    });
  })
);

// ===========================================
// GET RIDE STATUS
// ===========================================

/**
 * GET /api/rides/:id
 * Get ride details and current status
 */
router.get('/:id',
  param('id').isUUID(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const userType = req.user.type;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        stops: true,
        driver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            rating: true,
            vehicleMake: true,
            vehicleModel: true,
            vehicleColor: true,
            licensePlate: true,
            currentLat: true,
            currentLng: true
          }
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true
          }
        }
      }
    });

    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    // Verify access
    if (userType === 'user' && ride.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (userType === 'driver' && ride.driverId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get real-time driver location from Redis if ride is active
    let driverLocation = null;
    if (ride.driverId && ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS'].includes(ride.status)) {
      driverLocation = await redis.getDriverLocation(ride.driverId);
    }

    res.json({
      ride: {
        id: ride.id,
        status: ride.status,
        pickup: {
          address: ride.pickupAddress,
          lat: ride.pickupLat,
          lng: ride.pickupLng
        },
        dropoff: {
          address: ride.dropoffAddress,
          lat: ride.dropoffLat,
          lng: ride.dropoffLng
        },
        stops: ride.stops,
        serviceType: ride.serviceType,
        fare: {
          base: parseFloat(ride.baseFare),
          distance: parseFloat(ride.distanceFare),
          time: parseFloat(ride.timeFare),
          surge: ride.surgeMult,
          tip: parseFloat(ride.tip),
          promoDiscount: parseFloat(ride.promoDiscount),
          total: parseFloat(ride.totalFare)
        },
        distanceMiles: ride.distanceMiles,
        durationMinutes: ride.durationMinutes,
        driver: ride.driver ? {
          id: ride.driver.id,
          name: `${ride.driver.firstName} ${ride.driver.lastName.charAt(0)}.`,
          phone: ride.driver.phone,
          rating: ride.driver.rating,
          vehicle: {
            make: ride.driver.vehicleMake,
            model: ride.driver.vehicleModel,
            color: ride.driver.vehicleColor,
            plate: ride.driver.licensePlate
          },
          location: driverLocation
        } : null,
        rider: userType === 'driver' ? {
          id: ride.user.id,
          name: `${ride.user.firstName} ${ride.user.lastName.charAt(0)}.`,
          phone: ride.user.phone
        } : null,
        timeline: {
          requested: ride.requestedAt,
          accepted: ride.acceptedAt,
          arrived: ride.arrivedAt,
          started: ride.startedAt,
          completed: ride.completedAt,
          cancelled: ride.cancelledAt
        },
        isScheduled: ride.isScheduled,
        scheduledFor: ride.scheduledFor
      }
    });
  })
);

// ===========================================
// CANCEL RIDE
// ===========================================

/**
 * POST /api/rides/:id/cancel
 * Cancel a ride
 */
router.post('/:id/cancel',
  param('id').isUUID(),
  body('reason').optional().isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    const userType = req.user.type;

    const ride = await prisma.ride.findUnique({
      where: { id }
    });

    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    // Verify ownership
    if (userType === 'user' && ride.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (userType === 'driver' && ride.driverId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if can be cancelled
    if (['COMPLETED', 'CANCELLED'].includes(ride.status)) {
      return res.status(400).json({ error: 'Ride cannot be cancelled' });
    }

    // Determine cancellation fee (if driver already accepted)
    let cancellationFee = 0;
    if (ride.driverId && userType === 'user') {
      cancellationFee = 5.00; // $5 cancellation fee
    }

    // Update ride
    const updatedRide = await prisma.ride.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelledBy: userType === 'user' ? 'RIDER' : 'DRIVER'
      }
    });

    // Clear Redis state
    await redis.clearRideState(id);

    // Notify via socket
    const io = req.app.get('io');
    io.to(`ride:${id}`).emit('ride:cancelled', {
      rideId: id,
      cancelledBy: userType,
      reason,
      cancellationFee
    });

    res.json({
      success: true,
      cancellationFee,
      message: cancellationFee > 0 
        ? `Ride cancelled. A $${cancellationFee.toFixed(2)} fee will be charged.`
        : 'Ride cancelled successfully'
    });
  })
);

// ===========================================
// ADD TIP
// ===========================================

/**
 * POST /api/rides/:id/tip
 * Add tip to completed ride
 */
router.post('/:id/tip',
  requireUserType('user'),
  param('id').isUUID(),
  body('amount').isFloat({ min: 0, max: 100 }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount } = req.body;
    const userId = req.user.id;

    const ride = await prisma.ride.findUnique({
      where: { id }
    });

    if (!ride || ride.userId !== userId) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (ride.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Can only tip completed rides' });
    }

    // Update ride with tip
    await prisma.ride.update({
      where: { id },
      data: { tip: amount }
    });

    // Update driver earnings
    if (ride.driverId) {
      await prisma.earning.updateMany({
        where: { rideId: id },
        data: { tip: amount }
      });
    }

    res.json({
      success: true,
      message: `$${amount.toFixed(2)} tip added`
    });
  })
);

// ===========================================
// RATE RIDE
// ===========================================

/**
 * POST /api/rides/:id/rate
 * Rate a completed ride
 */
router.post('/:id/rate',
  param('id').isUUID(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().isString(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rating, comment } = req.body;
    const userId = req.user.id;
    const userType = req.user.type;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: { driver: true, user: true }
    });

    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (ride.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Can only rate completed rides' });
    }

    // Create rating
    const ratingData = {
      rideId: id,
      rating,
      comment
    };

    if (userType === 'user') {
      // User rating driver
      if (ride.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      ratingData.fromUserId = userId;
      ratingData.toDriverId = ride.driverId;
    } else {
      // Driver rating user
      if (ride.driverId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      ratingData.fromDriverId = userId;
      ratingData.toUserId = ride.userId;
    }

    await prisma.rating.create({ data: ratingData });

    // Update driver's average rating
    if (ratingData.toDriverId) {
      const avgRating = await prisma.rating.aggregate({
        where: { toDriverId: ratingData.toDriverId },
        _avg: { rating: true }
      });
      
      await prisma.driver.update({
        where: { id: ratingData.toDriverId },
        data: { rating: avgRating._avg.rating || 5.0 }
      });
    }

    res.json({
      success: true,
      message: 'Rating submitted'
    });
  })
);

// ===========================================
// GET RIDE HISTORY
// ===========================================

/**
 * GET /api/rides/history
 * Get user's ride history
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const userType = req.user.type;
    const { limit = 20, offset = 0, status } = req.query;

    const where = userType === 'user' 
      ? { userId }
      : { driverId: userId };

    if (status) {
      where.status = status;
    }

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
        include: {
          driver: userType === 'user' ? {
            select: {
              firstName: true,
              lastName: true,
              rating: true,
              vehicleMake: true,
              vehicleModel: true
            }
          } : false,
          user: userType === 'driver' ? {
            select: {
              firstName: true,
              lastName: true
            }
          } : false
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
        tip: parseFloat(r.tip),
        serviceType: r.serviceType,
        date: r.createdAt,
        driver: r.driver ? {
          name: `${r.driver.firstName} ${r.driver.lastName.charAt(0)}.`,
          rating: r.driver.rating,
          vehicle: `${r.driver.vehicleMake} ${r.driver.vehicleModel}`
        } : null,
        rider: r.user ? {
          name: `${r.user.firstName} ${r.user.lastName.charAt(0)}.`
        } : null
      })),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  })
);

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Get available drivers for a service type
 */
async function getAvailableDriversForService(nearbyDrivers, serviceType) {
  if (nearbyDrivers.length === 0) return [];

  const driverIds = nearbyDrivers.map(d => d.driverId);
  
  const drivers = await prisma.driver.findMany({
    where: {
      id: { in: driverIds },
      status: 'APPROVED',
      isOnline: true,
      serviceTypes: { has: serviceType }
    },
    select: { id: true }
  });

  const availableIds = new Set(drivers.map(d => d.id));
  return nearbyDrivers.filter(d => availableIds.has(d.driverId));
}

/**
 * Validate promo code
 */
async function validatePromoCode(code, userId, fareAmount) {
  const promo = await prisma.promoCode.findUnique({
    where: { code: code.toUpperCase() }
  });

  if (!promo || !promo.isActive) {
    return { valid: false, error: 'Invalid promo code' };
  }

  // Check expiry
  if (promo.validUntil && promo.validUntil < new Date()) {
    return { valid: false, error: 'Promo code expired' };
  }

  // Check usage limit
  if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
    return { valid: false, error: 'Promo code usage limit reached' };
  }

  // Check per-user limit
  const userUsages = await prisma.promoUsage.count({
    where: { promoCodeId: promo.id, userId }
  });
  if (userUsages >= promo.perUserLimit) {
    return { valid: false, error: 'You have already used this promo code' };
  }

  // Check minimum fare
  if (promo.minRideFare && fareAmount < parseFloat(promo.minRideFare)) {
    return { valid: false, error: `Minimum fare of $${promo.minRideFare} required` };
  }

  // Calculate discount
  let discount;
  if (promo.type === 'FIXED') {
    discount = Math.min(parseFloat(promo.value), fareAmount);
  } else {
    discount = fareAmount * (parseFloat(promo.value) / 100);
    if (promo.maxDiscount) {
      discount = Math.min(discount, parseFloat(promo.maxDiscount));
    }
  }

  return { valid: true, discount };
}

/**
 * Start driver matching process
 */
async function startDriverMatching(rideId, io) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId }
  });

  if (!ride) return;

  // Find nearby drivers
  const nearbyDrivers = await redis.findNearbyDrivers(
    ride.pickupLat, 
    ride.pickupLng, 
    10 // 10 mile radius
  );

  // Filter by service type and availability
  const availableDrivers = await getAvailableDriversForService(nearbyDrivers, ride.serviceType);

  if (availableDrivers.length === 0) {
    // No drivers available
    await prisma.ride.update({
      where: { id: rideId },
      data: { status: 'NO_DRIVERS' }
    });
    
    io.to(`user:${ride.userId}`).emit('ride:no_drivers', { rideId });
    return;
  }

  // Notify closest drivers (top 5)
  const driversToNotify = availableDrivers.slice(0, 5);
  
  for (const { driverId, distanceMiles } of driversToNotify) {
    io.to(`driver:${driverId}`).emit('ride:request', {
      rideId,
      pickup: {
        address: ride.pickupAddress,
        lat: ride.pickupLat,
        lng: ride.pickupLng
      },
      dropoff: {
        address: ride.dropoffAddress,
        lat: ride.dropoffLat,
        lng: ride.dropoffLng
      },
      serviceType: ride.serviceType,
      fare: parseFloat(ride.driverEarnings),
      distanceMiles: ride.distanceMiles,
      pickupDistanceMiles: distanceMiles,
      expiresIn: 30 // seconds
    });
  }

  // Set timeout for driver acceptance
  setTimeout(async () => {
    const currentRide = await prisma.ride.findUnique({ where: { id: rideId } });
    if (currentRide && currentRide.status === 'REQUESTED') {
      // Still no driver accepted, retry or mark as no drivers
      // In production, would implement retry logic
      await prisma.ride.update({
        where: { id: rideId },
        data: { status: 'NO_DRIVERS' }
      });
      io.to(`user:${ride.userId}`).emit('ride:no_drivers', { rideId });
    }
  }, 30000); // 30 second timeout
}

module.exports = router;
