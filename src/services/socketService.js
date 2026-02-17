/**
 * Socket.io Service
 * Real-time communication for rides, driver location, etc.
 */

const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { getJwtSecret } = require('../config/security');

const JWT_SECRET = getJwtSecret();

// Track connected clients
const connectedUsers = new Map();
const connectedDrivers = new Map();

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

function initializeSocketHandlers(io) {
  // Authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded?.id || !['user', 'driver'].includes(decoded.type)) {
        return next(new Error('Invalid token'));
      }
      socket.user = { id: decoded.id, type: decoded.type };
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, type } = socket.user;
    console.log(`🔌 ${type} connected: ${id}`);
    
    if (type === 'user') {
      connectedUsers.set(id, socket.id);
      socket.join(`user:${id}`);
    } else if (type === 'driver') {
      connectedDrivers.set(id, socket.id);
      socket.join(`driver:${id}`);
    }

    // Driver goes online
    socket.on('driver:online', async (data) => {
      if (type !== 'driver') return;
      const lat = Number(data?.lat);
      const lng = Number(data?.lng);

      if (!isValidCoordinate(lat, lng)) {
        return socket.emit('driver:error', { error: 'Invalid coordinates' });
      }

      await prisma.driver.update({
        where: { id },
        data: { isOnline: true, currentLat: lat, currentLng: lng, lastLocationUpdate: new Date() }
      });
      await redis.updateDriverLocation(id, lat, lng);
      socket.emit('driver:online_confirmed', { success: true });
    });

    // Driver goes offline
    socket.on('driver:offline', async () => {
      if (type !== 'driver') return;
      await prisma.driver.update({ where: { id }, data: { isOnline: false } });
      await redis.removeDriverFromPool(id);
      socket.emit('driver:offline_confirmed', { success: true });
    });

    // Driver location update
    socket.on('driver:location', async (data) => {
      if (type !== 'driver') return;
      const lat = Number(data?.lat);
      const lng = Number(data?.lng);
      const rideId = data?.rideId;

      if (!isValidCoordinate(lat, lng)) {
        return socket.emit('driver:error', { error: 'Invalid coordinates' });
      }

      await redis.updateDriverLocation(id, lat, lng);
      
      if (rideId) {
        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { driverId: true, userId: true }
        });

        if (!ride || ride.driverId !== id) {
          return socket.emit('driver:error', { error: 'Not authorized for this ride' });
        }

        io.to(`user:${ride.userId}`).emit('driver:location_update', {
          rideId,
          lat,
          lng,
          updatedAt: Date.now()
        });
        io.to(`ride:${rideId}`).emit('driver:location_update', {
          rideId,
          lat,
          lng,
          updatedAt: Date.now()
        });
      }
    });

    // Driver accepts ride
    socket.on('driver:accept_ride', async (data) => {
      if (type !== 'driver') return;
      const rideId = data?.rideId;

      if (!rideId) {
        return socket.emit('ride:accept_failed', { error: 'rideId is required' });
      }
      
      try {
        const driver = await prisma.driver.findUnique({
          where: { id },
          select: {
            status: true,
            isOnline: true,
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
        });

        if (!driver || driver.status !== 'APPROVED' || !driver.isOnline) {
          return socket.emit('ride:accept_failed', { error: 'Driver is not eligible to accept rides' });
        }

        // Atomic claim to avoid race conditions where multiple drivers accept.
        const claim = await prisma.ride.updateMany({
          where: { id: rideId, status: 'REQUESTED', driverId: null },
          data: { driverId: id, status: 'ACCEPTED', acceptedAt: new Date() }
        });

        if (claim.count === 0) {
          return socket.emit('ride:accept_failed', { error: 'Ride no longer available' });
        }

        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: {
            id: true,
            userId: true,
            pickupAddress: true,
            pickupLat: true,
            pickupLng: true,
            dropoffAddress: true,
            dropoffLat: true,
            dropoffLng: true,
            driverEarnings: true
          }
        });

        if (!ride) {
          return socket.emit('ride:accept_failed', { error: 'Ride not found after acceptance' });
        }
        
        socket.join(`ride:${rideId}`);
        
        io.to(`user:${ride.userId}`).emit('ride:accepted', {
          rideId,
          driver: {
            id,
            name: `${driver.firstName} ${driver.lastName.charAt(0)}.`,
            phone: driver.phone,
            rating: driver.rating,
            vehicle: { make: driver.vehicleMake, model: driver.vehicleModel, color: driver.vehicleColor, plate: driver.licensePlate },
            location: { lat: driver.currentLat, lng: driver.currentLng }
          }
        });
        
        socket.emit('ride:accept_confirmed', {
          rideId,
          pickup: { address: ride.pickupAddress, lat: ride.pickupLat, lng: ride.pickupLng },
          dropoff: { address: ride.dropoffAddress, lat: ride.dropoffLat, lng: ride.dropoffLng },
          fare: parseFloat(ride.driverEarnings || 0)
        });
      } catch (err) {
        socket.emit('ride:accept_failed', { error: 'Failed to accept ride' });
      }
    });

    // Driver arrives at pickup
    socket.on('driver:arrived', async (data) => {
      if (type !== 'driver') return;
      const rideId = data?.rideId;
      if (!rideId) return;

      const updated = await prisma.ride.updateMany({
        where: {
          id: rideId,
          driverId: id,
          status: { in: ['ACCEPTED', 'ARRIVING'] }
        },
        data: { status: 'ARRIVED', arrivedAt: new Date() }
      });

      if (updated.count === 0) {
        return socket.emit('ride:action_failed', { error: 'Ride is not in a state that can be marked as arrived' });
      }

      const ride = await prisma.ride.findUnique({ where: { id: rideId }, select: { userId: true } });
      if (!ride) return;
      io.to(`user:${ride.userId}`).emit('ride:driver_arrived', { rideId });
    });

    // Driver starts trip
    socket.on('driver:start_trip', async (data) => {
      if (type !== 'driver') return;
      const rideId = data?.rideId;
      if (!rideId) return;

      const updated = await prisma.ride.updateMany({
        where: { id: rideId, driverId: id, status: 'ARRIVED' },
        data: { status: 'IN_PROGRESS', startedAt: new Date() }
      });

      if (updated.count === 0) {
        return socket.emit('ride:action_failed', { error: 'Ride is not ready to start' });
      }

      const ride = await prisma.ride.findUnique({ where: { id: rideId }, select: { userId: true } });
      if (!ride) return;
      io.to(`user:${ride.userId}`).emit('ride:trip_started', { rideId });
    });

    // Driver completes trip
    socket.on('driver:complete_trip', async (data) => {
      if (type !== 'driver') return;
      const rideId = data?.rideId;
      if (!rideId) return;

      const updated = await prisma.ride.updateMany({
        where: { id: rideId, driverId: id, status: 'IN_PROGRESS' },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });

      if (updated.count === 0) {
        return socket.emit('ride:action_failed', { error: 'Ride is not in progress' });
      }

      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        include: { driver: true }
      });
      if (!ride) return;

      const existingEarning = await prisma.earning.findUnique({ where: { rideId } });
      if (!existingEarning) {
        await prisma.earning.create({
          data: {
            driverId: id,
            rideId,
            grossAmount: ride.totalFare,
            platformFee: ride.platformFee,
            netAmount: ride.driverEarnings,
            tip: ride.tip,
            status: 'PENDING'
          }
        });

        await prisma.driver.update({
          where: { id },
          data: { totalRides: { increment: 1 }, totalEarnings: { increment: parseFloat(ride.driverEarnings || 0) } }
        });
      }
      
      await redis.clearRideState(rideId);
      
      io.to(`user:${ride.userId}`).emit('ride:completed', {
        rideId,
        fare: parseFloat(ride.totalFare),
        driver: { id, name: `${ride.driver.firstName} ${ride.driver.lastName.charAt(0)}.`, rating: ride.driver.rating }
      });
      
      socket.emit('ride:complete_confirmed', { rideId, earnings: parseFloat(ride.driverEarnings) });
      socket.leave(`ride:${rideId}`);
    });

    // User subscribes to ride
    socket.on('ride:subscribe', async (data) => {
      const rideId = data?.rideId;
      if (!rideId) return;

      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        select: { userId: true, driverId: true }
      });

      if (!ride) {
        return;
      }

      const isParticipant = (type === 'user' && ride.userId === id)
        || (type === 'driver' && ride.driverId === id);

      if (!isParticipant) {
        return;
      }

      socket.join(`ride:${rideId}`);
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`🔌 ${type} disconnected: ${id}`);
      
      if (type === 'user') {
        connectedUsers.delete(id);
      } else if (type === 'driver') {
        connectedDrivers.delete(id);
        setTimeout(async () => {
          if (!connectedDrivers.has(id)) {
            await prisma.driver.update({ where: { id }, data: { isOnline: false } }).catch(() => {});
            await redis.removeDriverFromPool(id);
          }
        }, 30000);
      }
    });
  });

  console.log('✅ Socket.io handlers initialized');
}

module.exports = { initializeSocketHandlers };
