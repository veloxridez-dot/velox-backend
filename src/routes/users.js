/**
 * User Routes
 * Profile, saved places, payment methods
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireUserType } = require('../middleware/auth');

// Get current user profile
router.get('/me', requireUserType('user'), asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: {
      savedPlaces: true,
      paymentMethods: { select: { id: true, type: true, brand: true, last4: true, isDefault: true } }
    }
  });
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  res.json({
    id: user.id,
    phone: user.phone,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    savedPlaces: user.savedPlaces,
    paymentMethods: user.paymentMethods,
    settings: { notifyPush: user.notifyPush, notifySms: user.notifySms, notifyEmail: user.notifyEmail }
  });
}));

// Update profile
router.patch('/me', requireUserType('user'),
  body('firstName').optional().isLength({ min: 1, max: 50 }),
  body('lastName').optional().isLength({ min: 1, max: 50 }),
  body('email').optional().isEmail(),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, avatarUrl, settings } = req.body;
    
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;
    if (avatarUrl) updateData.avatarUrl = avatarUrl;
    if (settings) {
      if (settings.notifyPush !== undefined) updateData.notifyPush = settings.notifyPush;
      if (settings.notifySms !== undefined) updateData.notifySms = settings.notifySms;
      if (settings.notifyEmail !== undefined) updateData.notifyEmail = settings.notifyEmail;
    }
    
    const user = await prisma.user.update({ where: { id: req.user.id }, data: updateData });
    res.json({ success: true, user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } });
  })
);

// Add/update saved place
router.post('/me/places', requireUserType('user'),
  body('name').notEmpty(),
  body('address').notEmpty(),
  body('latitude').isFloat(),
  body('longitude').isFloat(),
  asyncHandler(async (req, res) => {
    const { name, address, latitude, longitude, icon } = req.body;
    
    const place = await prisma.savedPlace.upsert({
      where: { userId_name: { userId: req.user.id, name } },
      update: { address, latitude, longitude, icon: icon || '📍' },
      create: { userId: req.user.id, name, address, latitude, longitude, icon: icon || '📍' }
    });
    
    res.json({ success: true, place });
  })
);

// Delete saved place
router.delete('/me/places/:name', requireUserType('user'), asyncHandler(async (req, res) => {
  await prisma.savedPlace.delete({
    where: { userId_name: { userId: req.user.id, name: req.params.name } }
  });
  res.json({ success: true });
}));

module.exports = router;
