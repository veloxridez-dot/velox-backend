/**
 * Error Handling Middleware
 */

/**
 * 404 Not Found handler
 */
function notFound(req, res, next) {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
}

/**
 * Global error handler
 */
function errorHandler(err, req, res, next) {
  // Log error in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', err);
  }

  // Determine status code
  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    statusCode = 400;
  } else if (err.name === 'UnauthorizedError') {
    statusCode = 401;
  } else if (err.code === 'P2002') {
    // Prisma unique constraint violation
    statusCode = 409;
    err.message = 'A record with this value already exists';
  } else if (err.code === 'P2025') {
    // Prisma record not found
    statusCode = 404;
    err.message = 'Record not found';
  }

  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack,
      code: err.code
    })
  });
}

/**
 * Async handler wrapper to catch errors
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Custom API Error class
 */
class APIError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  notFound,
  errorHandler,
  asyncHandler,
  APIError
};
