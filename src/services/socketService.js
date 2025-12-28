/**
 * Socket.io Service
 * Real-time communication for rides, driver location, etc.
 */

const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const redis = require('../config/redis');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Track connected clients
const connectedUsers = new Map();
const connectedDrivers = new Map();

function initializeSocketHandlers(io) {
  // Authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
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
      const { lat, lng } = data;
      
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
      const { lat, lng, rideId } = data;
      
      await redis.updateDriverLocation(id, lat, lng);
      
      if (rideId) {
        const rideState = await redis.getRideState(rideId);
        if (rideState?.userId) {
          io.to(`user:${rideState.userId}`).emit('driver:location_update', { rideId, lat, lng, updatedAt: Date.now() });
        }
        io.to(`ride:${rideId}`).emit('driver:location_update', { rideId, lat, lng, updatedAt: Date.now() });
      }
    });

    // Driver accepts ride
    socket.on('driver:accept_ride', async (data) => {
      if (type !== 'driver') return;
      const { rideId } = data;
      
      try {
        const ride = await prisma.ride.findUnique({ where: { id: rideId } });
        if (!ride || ride.status !== 'REQUESTED') {
          return socket.emit('ride:accept_failed', { error: 'Ride no longer available' });
        }
        
        const driver = await prisma.driver.findUnique({
          where: { id },
          select: { firstName: true, lastName: true, phone: true, rating: true, vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true, currentLat: true, currentLng: true }
        });
        
        await prisma.ride.update({
          where: { id: rideId },
          data: { driverId: id, status: 'ACCEPTED', acceptedAt: new Date() }
        });
        
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
          fare: parseFloat(ride.driverEarnings)
        });
      } catch (err) {
        socket.emit('ride:accept_failed', { error: 'Failed to accept ride' });
      }
    });

    // Driver arrives at pickup
    socket.on('driver:arrived', async (data) => {
      if (type !== 'driver') return;
      const { rideId } = data;
      
      const ride = await prisma.ride.update({
        where: { id: rideId },
        data: { status: 'ARRIVED', arrivedAt: new Date() }
      });
      
      io.to(`user:${ride.userId}`).emit('ride:driver_arrived', { rideId });
    });

    // Driver starts trip
    socket.on('driver:start_trip', async (data) => {
      if (type !== 'driver') return;
      const { rideId } = data;
      
      const ride = await prisma.ride.update({
        where: { id: rideId },
        data: { status: 'IN_PROGRESS', startedAt: new Date() }
      });
      
      io.to(`user:${ride.userId}`).emit('ride:trip_started', { rideId });
    });

    // Driver completes trip
    socket.on('driver:complete_trip', async (data) => {
      if (type !== 'driver') return;
      const { rideId } = data;
      
      const ride = await prisma.ride.update({
        where: { id: rideId },
        data: { status: 'COMPLETED', completedAt: new Date() },
        include: { driver: true }
      });
      
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
        data: { totalRides: { increment: 1 }, totalEarnings: { increment: parseFloat(ride.driverEarnings) } }
      });
      
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
    socket.on('ride:subscribe', (data) => {
      socket.join(`ride:${data.rideId}`);
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
