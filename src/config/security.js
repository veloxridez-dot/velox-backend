/**
 * Security configuration helpers
 */
const crypto = require('crypto');

const DEV_FALLBACK_JWT_SECRET = 'dev-only-jwt-secret-change-before-production';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (secret && secret.length >= 32) {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set and at least 32 characters in production');
  }

  if (!secret) {
    console.warn('⚠️ JWT_SECRET is not set. Using development fallback secret.');
  } else {
    console.warn('⚠️ JWT_SECRET is shorter than 32 characters. Use a stronger secret.');
  }

  return secret || DEV_FALLBACK_JWT_SECRET;
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function getAllowedOrigins() {
  const configured = process.env.FRONTEND_URL || '';
  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) {
    // Non-browser clients (mobile apps, server-to-server) may not send Origin.
    return true;
  }

  if (!allowedOrigins.length) {
    return process.env.NODE_ENV !== 'production';
  }

  return allowedOrigins.includes(origin);
}

module.exports = {
  getJwtSecret,
  safeCompare,
  getAllowedOrigins,
  isOriginAllowed
};
