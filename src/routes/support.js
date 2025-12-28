/**
 * Support Ticket Routes
 * Customer support system
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');

// Create support ticket
router.post('/',
  authenticateToken,
  body('subject').notEmpty().isLength({ max: 200 }),
  body('description').notEmpty().isLength({ max: 5000 }),
  body('category').isIn(['RIDE_ISSUE', 'PAYMENT', 'DRIVER_COMPLAINT', 'RIDER_COMPLAINT', 'LOST_ITEM', 'SAFETY', 'ACCOUNT', 'OTHER']),
  body('rideId').optional().isUUID(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { subject, description, category, rideId, priority } = req.body;
    
    const ticketData = {
      subject,
      description,
      category,
      rideId,
      priority: priority || 'MEDIUM'
    };
    
    if (req.user.type === 'user') {
      ticketData.userId = req.user.id;
    } else {
      ticketData.driverId = req.user.id;
    }
    
    const ticket = await prisma.supportTicket.create({
      data: ticketData
    });
    
    res.status(201).json({ success: true, ticket });
  })
);

// Get user's tickets
router.get('/',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const where = req.user.type === 'user' 
      ? { userId: req.user.id }
      : { driverId: req.user.id };
    
    const tickets = await prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        responses: {
          orderBy: { createdAt: 'asc' },
          take: 1
        }
      }
    });
    
    res.json({ tickets });
  })
);

// Get single ticket
router.get('/:id',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: {
        responses: { orderBy: { createdAt: 'asc' } }
      }
    });
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    // Verify ownership
    if (req.user.type === 'user' && ticket.userId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (req.user.type === 'driver' && ticket.driverId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json({ ticket });
  })
);

// Add response to ticket
router.post('/:id/respond',
  authenticateToken,
  body('content').notEmpty().isLength({ max: 5000 }),
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id }
    });
    
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    const response = await prisma.ticketResponse.create({
      data: {
        ticketId: req.params.id,
        responderId: req.user.id,
        responderType: req.user.type,
        content: req.body.content
      }
    });
    
    // Update ticket status
    await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { status: 'WAITING_RESPONSE' }
    });
    
    res.json({ success: true, response });
  })
);

// Close ticket
router.post('/:id/close',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { 
        status: 'CLOSED',
        resolvedAt: new Date()
      }
    });
    
    res.json({ success: true, ticket });
  })
);

module.exports = router;
