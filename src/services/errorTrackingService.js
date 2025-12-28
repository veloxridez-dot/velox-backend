/**
 * Error Tracking & Logging Service
 * Sentry integration for production error monitoring
 */

let Sentry = null;

/**
 * Initialize Sentry error tracking
 */
function initErrorTracking(app) {
  if (!process.env.SENTRY_DSN) {
    console.log('ℹ️ Sentry not configured - using console logging');
    return;
  }
  
  try {
    Sentry = require('@sentry/node');
    
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.APP_VERSION || '1.0.0',
      
      // Performance monitoring
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      
      // Filter out non-critical errors
      ignoreErrors: [
        'ECONNRESET',
        'ETIMEDOUT',
        'Rate limit exceeded'
      ],
      
      beforeSend(event, hint) {
        // Don't send in development unless explicitly enabled
        if (process.env.NODE_ENV === 'development' && !process.env.SENTRY_DEV) {
          console.error('🐛 Error (not sent to Sentry):', hint.originalException);
          return null;
        }
        return event;
      }
    });
    
    // Express request handler (must be first middleware)
    app.use(Sentry.Handlers.requestHandler());
    
    // TracingHandler for performance monitoring
    app.use(Sentry.Handlers.tracingHandler());
    
    console.log('✅ Sentry error tracking initialized');
    
  } catch (err) {
    console.error('❌ Sentry initialization failed:', err.message);
  }
}

/**
 * Get Sentry error handler middleware (use after routes)
 */
function getErrorHandler() {
  if (Sentry) {
    return Sentry.Handlers.errorHandler({
      shouldHandleError(error) {
        // Report all 500 errors
        if (error.status >= 500) return true;
        // Also report 400 errors in production
        if (process.env.NODE_ENV === 'production' && error.status >= 400) return true;
        return false;
      }
    });
  }
  
  // Fallback error logger
  return (err, req, res, next) => {
    console.error('Error:', err);
    next(err);
  };
}

/**
 * Capture an exception manually
 */
function captureException(error, context = {}) {
  if (Sentry) {
    Sentry.captureException(error, {
      extra: context
    });
  } else {
    console.error('Exception:', error, context);
  }
}

/**
 * Capture a message (non-error)
 */
function captureMessage(message, level = 'info', context = {}) {
  if (Sentry) {
    Sentry.captureMessage(message, {
      level,
      extra: context
    });
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`, context);
  }
}

/**
 * Set user context for error tracking
 */
function setUser(user) {
  if (Sentry) {
    Sentry.setUser({
      id: user.id,
      email: user.email,
      username: user.phone,
      userType: user.type // 'user' or 'driver'
    });
  }
}

/**
 * Clear user context
 */
function clearUser() {
  if (Sentry) {
    Sentry.setUser(null);
  }
}

/**
 * Add breadcrumb for debugging
 */
function addBreadcrumb(message, category, data = {}) {
  if (Sentry) {
    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level: 'info'
    });
  }
}

/**
 * Start a transaction for performance monitoring
 */
function startTransaction(name, operation) {
  if (Sentry) {
    return Sentry.startTransaction({
      name,
      op: operation
    });
  }
  return null;
}

// ===========================================
// STRUCTURED LOGGING
// ===========================================

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] || LOG_LEVELS.INFO;

class Logger {
  constructor(module) {
    this.module = module;
  }
  
  _log(level, message, data = {}) {
    if (LOG_LEVELS[level] < currentLogLevel) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      module: this.module,
      message,
      ...data
    };
    
    if (process.env.LOG_FORMAT === 'json') {
      console.log(JSON.stringify(logEntry));
    } else {
      const emoji = { DEBUG: '🔍', INFO: 'ℹ️', WARN: '⚠️', ERROR: '❌' }[level];
      console.log(`${emoji} [${timestamp}] [${this.module}] ${message}`, Object.keys(data).length ? data : '');
    }
  }
  
  debug(message, data) { this._log('DEBUG', message, data); }
  info(message, data) { this._log('INFO', message, data); }
  warn(message, data) { this._log('WARN', message, data); }
  error(message, data) { 
    this._log('ERROR', message, data);
    if (data?.error) {
      captureException(data.error, { message, ...data });
    }
  }
}

function createLogger(module) {
  return new Logger(module);
}

// ===========================================
// REQUEST LOGGING MIDDLEWARE
// ===========================================

function requestLogger() {
  const logger = createLogger('HTTP');
  
  return (req, res, next) => {
    const start = Date.now();
    
    // Log request
    addBreadcrumb(`${req.method} ${req.path}`, 'http.request');
    
    // Capture response
    const originalSend = res.send;
    res.send = function(body) {
      const duration = Date.now() - start;
      
      logger.info(`${req.method} ${req.path}`, {
        status: res.statusCode,
        duration: `${duration}ms`,
        userId: req.user?.id,
        userType: req.user?.type
      });
      
      return originalSend.call(this, body);
    };
    
    next();
  };
}

module.exports = {
  initErrorTracking,
  getErrorHandler,
  captureException,
  captureMessage,
  setUser,
  clearUser,
  addBreadcrumb,
  startTransaction,
  createLogger,
  requestLogger
};
