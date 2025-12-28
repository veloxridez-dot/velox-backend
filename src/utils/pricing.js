/**
 * Pricing Utilities
 * Fare calculation, distance, surge pricing
 */

// Service type pricing configuration
const PRICING = {
  VELOX: {
    baseFare: 3.00,
    perMile: 1.75,
    perMinute: 0.25,
    minFare: 7.00,
    bookingFee: 2.50
  },
  VELOX_XL: {
    baseFare: 5.00,
    perMile: 2.50,
    perMinute: 0.35,
    minFare: 10.00,
    bookingFee: 2.50
  },
  VELOX_BLACK: {
    baseFare: 8.00,
    perMile: 3.50,
    perMinute: 0.50,
    minFare: 15.00,
    bookingFee: 3.00
  },
  VELOX_GREEN: {
    baseFare: 2.50,
    perMile: 1.50,
    perMinute: 0.20,
    minFare: 6.00,
    bookingFee: 2.00
  }
};

/**
 * Calculate fare for a ride
 */
function calculateFare(distanceMiles, durationMinutes, serviceType, surgeMultiplier = 1.0) {
  const pricing = PRICING[serviceType] || PRICING.VELOX;
  
  // Calculate base components
  const baseFare = pricing.baseFare;
  const distanceFare = distanceMiles * pricing.perMile;
  const timeFare = durationMinutes * pricing.perMinute;
  
  // Calculate subtotal before surge
  let subtotal = baseFare + distanceFare + timeFare;
  
  // Apply surge multiplier
  subtotal *= surgeMultiplier;
  
  // Add booking fee (not affected by surge)
  const bookingFee = pricing.bookingFee;
  
  // Calculate total
  let total = subtotal + bookingFee;
  
  // Ensure minimum fare
  if (total < pricing.minFare) {
    total = pricing.minFare;
  }
  
  // Round to 2 decimal places
  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    bookingFee: Math.round(bookingFee * 100) / 100,
    surgeMultiplier,
    totalFare: Math.round(total * 100) / 100,
    breakdown: {
      base: baseFare,
      distance: `$${pricing.perMile}/mi × ${distanceMiles.toFixed(1)} mi`,
      time: `$${pricing.perMinute}/min × ${durationMinutes} min`,
      surge: surgeMultiplier > 1 ? `${surgeMultiplier}x surge` : null,
      booking: bookingFee
    }
  };
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 * Returns distance in miles
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth's radius in miles
  
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Calculate estimated duration based on distance
 * Returns duration in minutes
 */
function calculateDuration(distanceMiles, timeOfDay = null) {
  // Base assumption: average 25 mph in city
  let avgSpeed = 25;
  
  // Adjust for time of day (rush hour)
  if (timeOfDay) {
    const hour = new Date(timeOfDay).getHours();
    if ((hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18)) {
      avgSpeed = 15; // Rush hour
    } else if (hour >= 22 || hour <= 5) {
      avgSpeed = 35; // Late night
    }
  }
  
  // Calculate minutes
  const minutes = (distanceMiles / avgSpeed) * 60;
  
  // Add buffer for stops, turns, etc.
  return Math.ceil(minutes * 1.2);
}

/**
 * Calculate surge multiplier based on demand
 * Placeholder - in production would analyze real-time data
 */
function calculateSurge(pickupLat, pickupLng, requestCount = 0, driverCount = 0) {
  // Simple surge calculation based on supply/demand ratio
  if (driverCount === 0) return 2.0; // High surge if no drivers
  
  const ratio = requestCount / driverCount;
  
  if (ratio <= 1) return 1.0;      // Normal
  if (ratio <= 2) return 1.25;     // Light surge
  if (ratio <= 3) return 1.5;      // Moderate surge
  if (ratio <= 5) return 1.75;     // High surge
  return 2.0;                       // Very high surge (capped at 2x)
}

/**
 * Get pricing for all service types
 */
function getAllPricing() {
  return PRICING;
}

module.exports = {
  calculateFare,
  calculateDistance,
  calculateDuration,
  calculateSurge,
  getAllPricing,
  PRICING
};
