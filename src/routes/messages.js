/**
 * Messaging Routes
 * In-app chat between rider and driver
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');
const messagingService = require('../services/messagingService');

// Send a message
router.post('/:rideId',
  authenticateToken,
  param('rideId').isUUID(),
  body('content').isString().isLength({ min: 1, max: 500 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { rideId } = req.params;
    const { content } = req.body;
    
    const result = await messagingService.sendMessage(
      rideId,
      req.user.id,
      req.user.type,
      content
    );
    
    // Emit via socket for real-time delivery
    const io = req.app.get('io');
    io.to(`${result.recipient.type}:${result.recipient.id}`).emit('message:received', {
      rideId,
      message: result.message
    });
    
    res.json({ success: true, message: result.message });
  })
);

// Get messages for a ride
router.get('/:rideId',
  authenticateToken,
  param('rideId').isUUID(),
  asyncHandler(async (req, res) => {
    const messages = await messagingService.getMessages(
      req.params.rideId,
      req.user.id,
      req.user.type
    );
    
    res.json({ messages });
  })
);

// Get quick message templates
router.get('/templates/:userType',
  asyncHandler(async (req, res) => {
    const { userType } = req.params;
    const templates = messagingService.getQuickMessages(userType);
    res.json({ templates });
  })
);

// Get unread count
router.get('/:rideId/unread',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const count = await messagingService.getUnreadCount(
      req.params.rideId,
      req.user.id
    );
    res.json({ unread: count });
  })
);

module.exports = router;
