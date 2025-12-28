/**
 * Authentication Routes
 * Phone verification, login, registration
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { generateTokens, verifyRefreshToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// Twilio client (optional - for phone verification)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ===========================================
// RIDER AUTH
// ===========================================

/**
 * POST /api/auth/rider/send-code
 * Send verification code to phone number
 */
router.post('/rider/send-code',
  body('phone').isMobilePhone('en-US').withMessage('Valid US phone number required'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone } = req.body;
    const formattedPhone = formatPhone(phone);

    // In development without Twilio, use mock code
    if (!twilioClient || process.env.NODE_ENV === 'development') {
      console.log(`📱 Mock verification code for ${formattedPhone}: 123456`);
      return res.json({ 
        success: true, 
        message: 'Verification code sent',
        // Only include mock code in development
        ...(process.env.NODE_ENV === 'development' && { mockCode: '123456' })
      });
    }

    // Send real verification via Twilio Verify
    try {
      await twilioClient.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: formattedPhone, channel: 'sms' });

      res.json({ success: true, message: 'Verification code sent' });
    } catch (err) {
      console.error('Twilio error:', err);
      res.status(500).json({ error: 'Failed to send verification code' });
    }
  })
);

/**
 * POST /api/auth/rider/verify-code
 * Verify phone code and login/register
 */
router.post('/rider/verify-code',
  body('phone').isMobilePhone('en-US'),
  body('code').isLength({ min: 4, max: 6 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone, code, firstName, lastName } = req.body;
    const formattedPhone = formatPhone(phone);

    // Verify code
    let verified = false;
    
    if (!twilioClient || process.env.NODE_ENV === 'development') {
      // Mock verification in development
      verified = code === '123456';
    } else {
      try {
        const verification = await twilioClient.verify.v2
          .services(process.env.TWILIO_VERIFY_SERVICE_SID)
          .verificationChecks.create({ to: formattedPhone, code });
        verified = verification.status === 'approved';
      } catch (err) {
        console.error('Verification error:', err);
      }
    }

    if (!verified) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { phone: formattedPhone }
    });

    const isNewUser = !user;

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          phone: formattedPhone,
          phoneVerified: true,
          firstName: firstName || 'Rider',
          lastName: lastName || '',
        }
      });
    } else {
      // Update existing user
      user = await prisma.user.update({
        where: { id: user.id },
        data: { 
          phoneVerified: true,
          lastLoginAt: new Date()
        }
      });
    }

    // Generate tokens
    const tokens = generateTokens({
      id: user.id,
      type: 'user',
      phone: user.phone,
      email: user.email
    });

    res.json({
      success: true,
      isNewUser,
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      },
      ...tokens
    });
  })
);

/**
 * POST /api/auth/rider/google
 * Login/register with Google
 */
router.post('/rider/google',
  body('idToken').notEmpty(),
  asyncHandler(async (req, res) => {
    const { idToken, phone } = req.body;
    
    // In production, verify Google ID token
    // For now, extract user info from token payload
    // const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    // const payload = ticket.getPayload();
    
    // Mock Google auth for development
    const googleUser = {
      email: req.body.email,
      firstName: req.body.firstName || 'Google',
      lastName: req.body.lastName || 'User',
    };

    if (!googleUser.email) {
      return res.status(400).json({ error: 'Email required from Google account' });
    }

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { email: googleUser.email }
    });

    const isNewUser = !user;

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: googleUser.email,
          phone: phone || `temp_${Date.now()}`, // Temporary phone, prompt to add real one
          firstName: googleUser.firstName,
          lastName: googleUser.lastName,
        }
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      });
    }

    const tokens = generateTokens({
      id: user.id,
      type: 'user',
      phone: user.phone,
      email: user.email
    });

    res.json({
      success: true,
      isNewUser,
      needsPhone: !user.phone || user.phone.startsWith('temp_'),
      user: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      },
      ...tokens
    });
  })
);

// ===========================================
// DRIVER AUTH
// ===========================================

/**
 * POST /api/auth/driver/register
 * Register new driver (starts approval process)
 */
router.post('/driver/register',
  body('email').isEmail(),
  body('phone').isMobilePhone('en-US'),
  body('password').isLength({ min: 8 }),
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('vehicleMake').notEmpty(),
  body('vehicleModel').notEmpty(),
  body('vehicleYear').isInt({ min: 1990, max: new Date().getFullYear() + 1 }),
  body('vehicleColor').notEmpty(),
  body('licensePlate').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      email, phone, password, firstName, lastName,
      vehicleMake, vehicleModel, vehicleYear, vehicleColor, licensePlate
    } = req.body;

    const formattedPhone = formatPhone(phone);

    // Check if driver already exists
    const existing = await prisma.driver.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { phone: formattedPhone }
        ]
      }
    });

    if (existing) {
      return res.status(409).json({ error: 'Driver with this email or phone already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create driver (pending approval)
    const driver = await prisma.driver.create({
      data: {
        email: email.toLowerCase(),
        phone: formattedPhone,
        passwordHash,
        firstName,
        lastName,
        vehicleMake,
        vehicleModel,
        vehicleYear: parseInt(vehicleYear),
        vehicleColor,
        licensePlate: licensePlate.toUpperCase(),
        status: 'PENDING_APPROVAL',
        serviceTypes: ['VELOX'] // Default service type
      }
    });

    res.status(201).json({
      success: true,
      message: 'Registration submitted. You will be notified once approved.',
      driverId: driver.id
    });
  })
);

/**
 * POST /api/auth/driver/login
 * Driver login with email/password
 */
router.post('/driver/login',
  body('email').isEmail(),
  body('password').notEmpty(),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const driver = await prisma.driver.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (!driver) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, driver.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (driver.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    }

    if (driver.status === 'PENDING_APPROVAL') {
      return res.status(403).json({ 
        error: 'Account pending approval',
        status: 'PENDING_APPROVAL'
      });
    }

    if (driver.status === 'REJECTED') {
      return res.status(403).json({ error: 'Application was not approved. Please contact support.' });
    }

    const tokens = generateTokens({
      id: driver.id,
      type: 'driver',
      phone: driver.phone,
      email: driver.email
    });

    res.json({
      success: true,
      driver: {
        id: driver.id,
        email: driver.email,
        phone: driver.phone,
        firstName: driver.firstName,
        lastName: driver.lastName,
        rating: driver.rating,
        totalRides: driver.totalRides,
        vehicle: {
          make: driver.vehicleMake,
          model: driver.vehicleModel,
          year: driver.vehicleYear,
          color: driver.vehicleColor,
          plate: driver.licensePlate
        },
        status: driver.status
      },
      ...tokens
    });
  })
);

// ===========================================
// TOKEN REFRESH
// ===========================================

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post('/refresh',
  body('refreshToken').notEmpty(),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Verify user/driver still exists
    if (decoded.type === 'user') {
      const user = await prisma.user.findUnique({ where: { id: decoded.id } });
      if (!user || user.status !== 'ACTIVE') {
        return res.status(401).json({ error: 'Account not found or inactive' });
      }
    } else if (decoded.type === 'driver') {
      const driver = await prisma.driver.findUnique({ where: { id: decoded.id } });
      if (!driver || driver.status === 'SUSPENDED') {
        return res.status(401).json({ error: 'Account not found or suspended' });
      }
    }

    const tokens = generateTokens({
      id: decoded.id,
      type: decoded.type,
      phone: decoded.phone,
      email: decoded.email
    });

    res.json(tokens);
  })
);

// ===========================================
// HELPERS
// ===========================================

function formatPhone(phone) {
  // Remove all non-digits
  const digits = phone.replace(/\D/g, '');
  // Ensure it starts with +1 for US
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

module.exports = router;
