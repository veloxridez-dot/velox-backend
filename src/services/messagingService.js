/**
 * In-App Messaging Service
 * Real-time chat between rider and driver during active rides
 */

const prisma = require('../config/prisma');

async function assertRideParticipant(rideId, userId, userType) {
  if (!['user', 'driver'].includes(userType)) {
    throw new Error('Not authorized');
  }

  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { id: true, userId: true, driverId: true }
  });

  if (!ride) {
    throw new Error('Ride not found');
  }

  if (userType === 'user' && ride.userId !== userId) {
    throw new Error('Not authorized');
  }
  if (userType === 'driver' && ride.driverId !== userId) {
    throw new Error('Not authorized');
  }

  return ride;
}

/**
 * Send a message in a ride conversation
 */
async function sendMessage(rideId, senderId, senderType, content) {
  if (!['user', 'driver'].includes(senderType)) {
    throw new Error('Not authorized to send messages');
  }

  // Validate ride exists and is active
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { user: true, driver: true }
  });
  
  if (!ride) {
    throw new Error('Ride not found');
  }
  
  // Verify sender is part of the ride
  if (senderType === 'user' && ride.userId !== senderId) {
    throw new Error('Not authorized to send messages in this ride');
  }
  if (senderType === 'driver' && ride.driverId !== senderId) {
    throw new Error('Not authorized to send messages in this ride');
  }
  
  // Only allow messages during active ride
  const activeStatuses = ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'IN_PROGRESS'];
  if (!activeStatuses.includes(ride.status)) {
    throw new Error('Can only send messages during active rides');
  }
  
  // Create message
  const message = await prisma.message.create({
    data: {
      rideId,
      senderId,
      senderType,
      content,
      status: 'SENT'
    }
  });
  
  // Determine recipient
  const recipientId = senderType === 'user' ? ride.driverId : ride.userId;
  const recipientType = senderType === 'user' ? 'driver' : 'user';
  
  return {
    message: {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      senderType: message.senderType,
      createdAt: message.createdAt
    },
    recipient: {
      id: recipientId,
      type: recipientType
    }
  };
}

/**
 * Get messages for a ride
 */
async function getMessages(rideId, userId, userType) {
  await assertRideParticipant(rideId, userId, userType);
  
  const messages = await prisma.message.findMany({
    where: { rideId },
    orderBy: { createdAt: 'asc' }
  });
  
  // Mark messages as read
  await prisma.message.updateMany({
    where: {
      rideId,
      senderId: { not: userId },
      status: { not: 'READ' }
    },
    data: { status: 'READ', readAt: new Date() }
  });
  
  return messages.map(m => ({
    id: m.id,
    content: m.content,
    senderId: m.senderId,
    senderType: m.senderType,
    isMe: m.senderId === userId,
    createdAt: m.createdAt,
    status: m.status
  }));
}

/**
 * Mark messages as delivered
 */
async function markDelivered(messageIds) {
  await prisma.message.updateMany({
    where: {
      id: { in: messageIds },
      status: 'SENT'
    },
    data: { status: 'DELIVERED', deliveredAt: new Date() }
  });
}

/**
 * Get unread message count for a ride
 */
async function getUnreadCount(rideId, userId, userType) {
  await assertRideParticipant(rideId, userId, userType);

  return prisma.message.count({
    where: {
      rideId,
      senderId: { not: userId },
      status: { not: 'READ' }
    }
  });
}

/**
 * Mark specific messages as read after validating ride access
 */
async function markMessagesRead(rideId, messageIds, userId, userType) {
  const ride = await assertRideParticipant(rideId, userId, userType);

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { count: 0, ride };
  }

  const scopedMessages = await prisma.message.findMany({
    where: {
      id: { in: messageIds },
      rideId,
      senderId: { not: userId }
    },
    select: { id: true }
  });

  if (!scopedMessages.length) {
    return { count: 0, ride };
  }

  const ids = scopedMessages.map(m => m.id);
  const result = await prisma.message.updateMany({
    where: { id: { in: ids }, status: { not: 'READ' } },
    data: { status: 'READ', readAt: new Date() }
  });

  return { count: result.count, ride };
}

/**
 * Pre-defined quick messages for common scenarios
 */
const QUICK_MESSAGES = {
  rider: [
    { id: 'omw', text: "I'm on my way out" },
    { id: 'wait', text: "Can you wait a moment?" },
    { id: 'where', text: "Where exactly are you?" },
    { id: 'calling', text: "I'll call you" },
    { id: 'black_car', text: "I'm looking for a black car" },
    { id: 'gate', text: "I'm at the gate/entrance" }
  ],
  driver: [
    { id: 'arrived', text: "I've arrived" },
    { id: 'waiting', text: "I'm waiting outside" },
    { id: 'location', text: "I'm at the pin location" },
    { id: 'traffic', text: "Stuck in traffic, be there soon" },
    { id: 'calling', text: "I'll call you" },
    { id: 'cant_find', text: "I can't find the exact location" }
  ]
};

function getQuickMessages(userType) {
  return QUICK_MESSAGES[userType] || [];
}

/**
 * Socket.io event handlers for messaging
 */
function setupMessageSocketHandlers(io, socket) {
  // Send message
  socket.on('message:send', async (data) => {
    try {
      const { rideId, content } = data;
      const { id: senderId, type: senderType } = socket.user;
      
      const result = await sendMessage(rideId, senderId, senderType, content);
      
      // Emit to sender (confirmation)
      socket.emit('message:sent', result.message);
      
      // Emit to recipient
      io.to(`${result.recipient.type}:${result.recipient.id}`).emit('message:received', {
        rideId,
        message: result.message
      });
      
    } catch (err) {
      socket.emit('message:error', { error: err.message });
    }
  });
  
  // Mark as read
  socket.on('message:read', async (data) => {
    try {
      const { rideId, messageIds } = data;
      const result = await markMessagesRead(rideId, messageIds, socket.user.id, socket.user.type);

      if (result.count > 0) {
        const recipientId = socket.user.type === 'user' ? result.ride.driverId : result.ride.userId;
        const recipientType = socket.user.type === 'user' ? 'driver' : 'user';

        if (recipientId) {
          io.to(`${recipientType}:${recipientId}`).emit('message:read_receipt', {
            rideId,
            messageIds
          });
        }
      }
    } catch (err) {
      socket.emit('message:error', { error: err.message });
    }
  });
  
  // Typing indicator
  socket.on('message:typing', async (data) => {
    try {
      const { rideId, isTyping } = data;
      const ride = await assertRideParticipant(rideId, socket.user.id, socket.user.type);
      const recipientId = socket.user.type === 'user' ? ride.driverId : ride.userId;
      const recipientType = socket.user.type === 'user' ? 'driver' : 'user';

      if (recipientId) {
        io.to(`${recipientType}:${recipientId}`).emit('message:typing', {
          rideId,
          isTyping: Boolean(isTyping),
          senderType: socket.user.type
        });
      }
    } catch (err) {
      socket.emit('message:error', { error: err.message });
    }
  });
}

module.exports = {
  sendMessage,
  getMessages,
  markDelivered,
  markMessagesRead,
  getUnreadCount,
  getQuickMessages,
  setupMessageSocketHandlers,
  QUICK_MESSAGES
};
