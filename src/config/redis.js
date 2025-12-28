/**
 * Redis Client Configuration
 * Used for real-time driver locations and caching
 */

const Redis = require('ioredis');

let redis;

// Redis key prefixes
const KEYS = {
  DRIVER_LOCATION: 'driver:location:', // driver:location:{driverId}
  DRIVER_ONLINE: 'drivers:online',      // Sorted set of online drivers
  RIDE_STATE: 'ride:state:',            // ride:state:{rideId}
  SURGE_ZONE: 'surge:zone:',            // surge:zone:{zoneId}
  RATE_LIMIT: 'ratelimit:',             // ratelimit:{key}
};

function getRedisClient() {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redis.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });

    redis.on('close', () => {
      console.log('⚠️ Redis connection closed');
    });
  }
  
  return redis;
}

// ===========================================
// DRIVER LOCATION FUNCTIONS
// ===========================================

/**
 * Update driver's current location
 */
async function updateDriverLocation(driverId, lat, lng) {
  const client = getRedisClient();
  const key = KEYS.DRIVER_LOCATION + driverId;
  
  const data = JSON.stringify({
    lat,
    lng,
    updatedAt: Date.now()
  });
  
  // Store location with 5-minute expiry (driver goes offline if no updates)
  await client.setex(key, 300, data);
  
  // Add to geo index for proximity searches
  // Redis GEO uses (longitude, latitude) order
  await client.geoadd(KEYS.DRIVER_ONLINE, lng, lat, driverId);
}

/**
 * Get driver's current location
 */
async function getDriverLocation(driverId) {
  const client = getRedisClient();
  const key = KEYS.DRIVER_LOCATION + driverId;
  
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

/**
 * Find nearby drivers within radius (miles)
 */
async function findNearbyDrivers(lat, lng, radiusMiles = 10, limit = 20) {
  const client = getRedisClient();
  
  // GEORADIUS returns drivers within radius, sorted by distance
  // Using 'mi' for miles, 'WITHDIST' to get distances
  const results = await client.georadius(
    KEYS.DRIVER_ONLINE,
    lng, lat,
    radiusMiles, 'mi',
    'WITHDIST',
    'ASC',
    'COUNT', limit
  );
  
  // Results format: [[driverId, distance], ...]
  return results.map(([driverId, distance]) => ({
    driverId,
    distanceMiles: parseFloat(distance)
  }));
}

/**
 * Remove driver from online pool
 */
async function removeDriverFromPool(driverId) {
  const client = getRedisClient();
  
  await client.del(KEYS.DRIVER_LOCATION + driverId);
  await client.zrem(KEYS.DRIVER_ONLINE, driverId);
}

/**
 * Get all online drivers (for admin dashboard)
 */
async function getAllOnlineDrivers() {
  const client = getRedisClient();
  
  // Get all members with their positions
  const positions = await client.geopos(KEYS.DRIVER_ONLINE, await client.zrange(KEYS.DRIVER_ONLINE, 0, -1));
  const driverIds = await client.zrange(KEYS.DRIVER_ONLINE, 0, -1);
  
  return driverIds.map((id, i) => ({
    driverId: id,
    lng: positions[i] ? parseFloat(positions[i][0]) : null,
    lat: positions[i] ? parseFloat(positions[i][1]) : null
  })).filter(d => d.lat && d.lng);
}

// ===========================================
// RIDE STATE FUNCTIONS
// ===========================================

/**
 * Store active ride state for quick access
 */
async function setRideState(rideId, state) {
  const client = getRedisClient();
  const key = KEYS.RIDE_STATE + rideId;
  
  await client.setex(key, 3600, JSON.stringify(state)); // 1 hour expiry
}

/**
 * Get active ride state
 */
async function getRideState(rideId) {
  const client = getRedisClient();
  const key = KEYS.RIDE_STATE + rideId;
  
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

/**
 * Clear ride state
 */
async function clearRideState(rideId) {
  const client = getRedisClient();
  await client.del(KEYS.RIDE_STATE + rideId);
}

module.exports = {
  getRedisClient,
  KEYS,
  // Driver location
  updateDriverLocation,
  getDriverLocation,
  findNearbyDrivers,
  removeDriverFromPool,
  getAllOnlineDrivers,
  // Ride state
  setRideState,
  getRideState,
  clearRideState,
};
