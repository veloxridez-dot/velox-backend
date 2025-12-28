/**
 * VeloX Backend Server - Complete Production Version
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');
const messageRoutes = require('./routes/messages');
const supportRoutes = require('./routes/support');

// Services
const { initializeSocketHandlers } = require('./services/socketService');
const { initErrorTracking, getErrorHandler, requestLogger } = require('./services/errorTrackingService');
const { initFirebase } = require('./services/pushService');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

// Initialize services
initErrorTracking(app);
initFirebase();

// Socket.io
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000, pingInterval: 25000
});
app.set('io', io);

// Middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' }, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger());
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', authenticateToken, rideRoutes);
app.use('/api/payments', authenticateToken, paymentRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/messages', authenticateToken, messageRoutes);
app.use('/api/support', authenticateToken, supportRoutes);
app.use('/api/admin', adminRoutes);

// Webhooks
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), require('./routes/webhooks'));
app.post('/webhooks/checkr', express.json(), async (req, res) => {
  try {
    const bgService = require('./services/backgroundCheckService');
    await bgService.handleCheckrWebhook(req.body);
    res.json({ received: true });
  } catch (err) { res.status(500).json({ error: 'Webhook failed' }); }
});

// Error handling
app.use(getErrorHandler());
app.use(notFound);
app.use(errorHandler);

// Socket handlers
initializeSocketHandlers(io);
const messagingService = require('./services/messagingService');
io.on('connection', (socket) => { if (socket.user) messagingService.setupMessageSocketHandlers(io, socket); });

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚗 VeloX Backend running on port ${PORT}`));

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
module.exports = { app, server, io };
