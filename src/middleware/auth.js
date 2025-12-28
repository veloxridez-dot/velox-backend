/**
 * Authentication Middleware
 * JWT token verification and role-based access
 */

const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * Verify JWT token and attach user to request
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Attach user info to request
    req.user = {
      id: decoded.id,
      type: decoded.type, // 'user' or 'driver'
      email: decoded.email,
      phone: decoded.phone
    };

    // Verify user still exists and is active
    if (decoded.type === 'user') {
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, status: true }
      });
      
      if (!user || user.status !== 'ACTIVE') {
        return res.status(401).json({ error: 'Account not found or inactive' });
      }
    } else if (decoded.type === 'driver') {
      const driver = await prisma.driver.findUnique({
        where: { id: decoded.id },
        select: { id: true, status: true }
      });
      
      if (!driver || driver.status === 'SUSPENDED') {
        return res.status(401).json({ error: 'Driver account not found or suspended' });
      }
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

/**
 * Optional authentication - attaches user if token present, continues otherwise
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.id,
      type: decoded.type,
      email: decoded.email,
      phone: decoded.phone
    };
  } catch (err) {
    // Invalid token, continue without user
  }

  next();
}

/**
 * Require specific user type
 */
function requireUserType(type) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (req.user.type !== type) {
      return res.status(403).json({ error: `Access denied. ${type} account required.` });
    }
    
    next();
  };
}

/**
 * Admin authentication (separate from user/driver)
 */
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Admin access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.type !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    req.admin = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    };
    
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
}

/**
 * Generate tokens
 */
function generateTokens(payload) {
  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
  
  const refreshToken = jwt.sign(
    { ...payload, tokenType: 'refresh' },
    JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
  
  return { accessToken, refreshToken };
}

/**
 * Verify refresh token
 */
function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.tokenType !== 'refresh') {
      throw new Error('Invalid token type');
    }
    return decoded;
  } catch (err) {
    return null;
  }
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireUserType,
  authenticateAdmin,
  generateTokens,
  verifyRefreshToken
};
