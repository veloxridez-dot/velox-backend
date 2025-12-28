/**
 * Push Notification Service
 * Firebase Cloud Messaging for iOS/Android/Web push notifications
 */

const admin = require('firebase-admin');
const prisma = require('../config/prisma');

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK
 */
function initFirebase() {
  if (firebaseApp) return firebaseApp;
  
  if (!process.env.FIREBASE_PROJECT_ID) {
    console.warn('⚠️ Firebase not configured - push notifications disabled');
    return null;
  }
  
  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
    console.log('✅ Firebase Admin initialized');
    return firebaseApp;
  } catch (err) {
    console.error('❌ Firebase init error:', err.message);
    return null;
  }
}

/**
 * Store device token for user/driver
 */
async function registerDevice(entityId, entityType, token, platform) {
  // entityType: 'user' or 'driver'
  // platform: 'ios', 'android', 'web'
  
  await prisma.deviceToken.upsert({
    where: {
      entityId_entityType_token: { entityId, entityType, token }
    },
    update: { updatedAt: new Date(), platform },
    create: { entityId, entityType, token, platform }
  });
}

/**
 * Remove device token
 */
async function unregisterDevice(token) {
  await prisma.deviceToken.deleteMany({ where: { token } });
}

/**
 * Send push notification
 */
async function sendPush(entityId, entityType, notification, data = {}) {
  if (!firebaseApp) {
    initFirebase();
    if (!firebaseApp) return { success: false, error: 'Firebase not configured' };
  }
  
  // Get device tokens
  const devices = await prisma.deviceToken.findMany({
    where: { entityId, entityType }
  });
  
  if (devices.length === 0) {
    return { success: false, error: 'No registered devices' };
  }
  
  const tokens = devices.map(d => d.token);
  
  const message = {
    notification: {
      title: notification.title,
      body: notification.body,
      ...(notification.imageUrl && { imageUrl: notification.imageUrl })
    },
    data: {
      ...data,
      click_action: data.click_action || 'FLUTTER_NOTIFICATION_CLICK'
    },
    tokens
  };
  
  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    
    // Remove invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error?.code === 'messaging/invalid-registration-token') {
          invalidTokens.push(tokens[idx]);
        }
      });
      
      if (invalidTokens.length > 0) {
        await prisma.deviceToken.deleteMany({
          where: { token: { in: invalidTokens } }
        });
      }
    }
    
    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount
    };
  } catch (err) {
    console.error('Push notification error:', err);
    return { success: false, error: err.message };
  }
}

// ===========================================
// RIDER NOTIFICATIONS
// ===========================================

async function notifyRiderDriverAccepted(userId, driver, eta) {
  return sendPush(userId, 'user', {
    title: 'Driver on the way! 🚗',
    body: `${driver.name} is heading to you. ETA: ${eta} min`
  }, {
    type: 'driver_accepted',
    driverId: driver.id
  });
}

async function notifyRiderDriverArrived(userId, driver) {
  return sendPush(userId, 'user', {
    title: 'Your driver has arrived! 📍',
    body: `${driver.name} is waiting outside`
  }, {
    type: 'driver_arrived',
    driverId: driver.id
  });
}

async function notifyRiderTripStarted(userId, destination) {
  return sendPush(userId, 'user', {
    title: 'Trip started 🎯',
    body: `On your way to ${destination}`
  }, { type: 'trip_started' });
}

async function notifyRiderTripCompleted(userId, fare, driverName) {
  return sendPush(userId, 'user', {
    title: 'Trip completed! ✅',
    body: `Total: $${fare.toFixed(2)}. Rate your ride with ${driverName}`
  }, { type: 'trip_completed' });
}

async function notifyRiderPromo(userId, promoCode, discount) {
  return sendPush(userId, 'user', {
    title: 'Special offer! 🎉',
    body: `Use code ${promoCode} for ${discount} off your next ride`
  }, { type: 'promo', promoCode });
}

// ===========================================
// DRIVER NOTIFICATIONS
// ===========================================

async function notifyDriverNewRequest(driverId, pickup, fare, distance) {
  return sendPush(driverId, 'driver', {
    title: 'New ride request! 💰',
    body: `$${fare.toFixed(2)} • ${distance.toFixed(1)} mi away • ${pickup}`
  }, {
    type: 'ride_request',
    sound: 'ride_request.wav'
  });
}

async function notifyDriverScheduledReminder(driverId, pickup, scheduledTime) {
  const time = new Date(scheduledTime).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
  
  return sendPush(driverId, 'driver', {
    title: 'Scheduled ride in 30 min ⏰',
    body: `Pickup at ${pickup} at ${time}`
  }, { type: 'scheduled_reminder' });
}

async function notifyDriverPayoutComplete(driverId, amount) {
  return sendPush(driverId, 'driver', {
    title: 'Payout sent! 💵',
    body: `$${amount.toFixed(2)} is on its way to your bank`
  }, { type: 'payout_complete' });
}

async function notifyDriverApproved(driverId) {
  return sendPush(driverId, 'driver', {
    title: 'Welcome to VeloX! 🎉',
    body: 'Your application has been approved. Start earning today!'
  }, { type: 'approved' });
}

module.exports = {
  initFirebase,
  registerDevice,
  unregisterDevice,
  sendPush,
  // Rider
  notifyRiderDriverAccepted,
  notifyRiderDriverArrived,
  notifyRiderTripStarted,
  notifyRiderTripCompleted,
  notifyRiderPromo,
  // Driver
  notifyDriverNewRequest,
  notifyDriverScheduledReminder,
  notifyDriverPayoutComplete,
  notifyDriverApproved
};
