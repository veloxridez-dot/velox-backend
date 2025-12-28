# VeloX Backend API

Production-ready backend for the VeloX rideshare application.

## 🏗️ Architecture

Based on industry best practices from Uber/Lyft systems:

- **Node.js + Express** - REST API server
- **PostgreSQL + PostGIS** - Relational database with geospatial queries
- **Redis** - Real-time driver locations & caching
- **Socket.io** - Live updates for rides
- **Prisma ORM** - Type-safe database access
- **Stripe Connect** - Payment processing & driver payouts

## 📁 Project Structure

```
velox-backend/
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── seed.js          # Test data
├── src/
│   ├── config/
│   │   ├── prisma.js    # Database client
│   │   └── redis.js     # Redis client & geo functions
│   ├── middleware/
│   │   ├── auth.js      # JWT authentication
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── auth.js      # Login, registration
│   │   ├── rides.js     # Ride booking & tracking
│   │   ├── users.js     # Rider profiles
│   │   ├── drivers.js   # Driver profiles & earnings
│   │   ├── payments.js  # Stripe integration
│   │   ├── admin.js     # Dashboard
│   │   └── webhooks.js  # Stripe webhooks
│   ├── services/
│   │   └── socketService.js  # Real-time events
│   ├── utils/
│   │   └── pricing.js   # Fare calculations
│   └── server.js        # Entry point
├── .env.example         # Environment template
└── package.json
```

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+ with PostGIS extension
- Redis 6+
- Stripe account

### 2. Install Dependencies

```bash
cd velox-backend
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Setup Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# (Optional) Seed test data
npm run db:seed
```

### 5. Start Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm start
```

Server runs at `http://localhost:3001`

## 🔑 API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/rider/send-code` | Send phone verification |
| POST | `/api/auth/rider/verify-code` | Verify & login |
| POST | `/api/auth/driver/register` | Driver registration |
| POST | `/api/auth/driver/login` | Driver login |
| POST | `/api/auth/refresh` | Refresh token |

### Rides

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/rides/estimate` | Get fare estimate |
| POST | `/api/rides/request` | Request a ride |
| GET | `/api/rides/:id` | Get ride details |
| POST | `/api/rides/:id/cancel` | Cancel ride |
| POST | `/api/rides/:id/tip` | Add tip |
| POST | `/api/rides/:id/rate` | Rate ride |
| GET | `/api/rides` | Ride history |

### Drivers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/drivers/me` | Get profile |
| POST | `/api/drivers/location` | Update location |
| POST | `/api/drivers/status` | Go online/offline |
| GET | `/api/drivers/earnings` | Earnings history |
| GET | `/api/drivers/requests` | Available rides |

### Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payments/methods` | Get payment methods |
| POST | `/api/payments/methods` | Add payment method |
| POST | `/api/payments/driver/connect/onboard` | Stripe Connect setup |
| GET | `/api/payments/driver/balance` | Available balance |
| POST | `/api/payments/driver/payout/instant` | Request instant payout |

## 🔌 Socket.io Events

### Driver Events

```javascript
// Go online
socket.emit('driver:online', { lat, lng });

// Update location
socket.emit('driver:location', { lat, lng, rideId });

// Accept ride
socket.emit('driver:accept_ride', { rideId });

// Status updates
socket.emit('driver:arrived', { rideId });
socket.emit('driver:start_trip', { rideId });
socket.emit('driver:complete_trip', { rideId });
```

### Rider Events (Received)

```javascript
socket.on('ride:accepted', (data) => { /* driver info */ });
socket.on('driver:location_update', (data) => { /* lat, lng */ });
socket.on('ride:driver_arrived', (data) => {});
socket.on('ride:trip_started', (data) => {});
socket.on('ride:completed', (data) => { /* fare, tip */ });
```

## 🗄️ Database Schema

### Key Models

- **User** - Riders with phone auth
- **Driver** - Drivers with vehicle & documents
- **Ride** - Ride requests with full lifecycle
- **Earning** - Driver earnings per ride
- **Payout** - Driver payout requests
- **PaymentMethod** - Saved payment cards
- **PromoCode** - Discount codes

## 💳 Stripe Integration

### Rider Payments
1. Add payment method with `stripe.js`
2. Attach to Stripe customer
3. Charge on ride completion

### Driver Payouts (Stripe Connect)
1. Create Connect account
2. Complete onboarding
3. Receive automatic transfers
4. Request instant payouts (1.5% fee)

## 🚢 Deployment

### Recommended Services

| Service | Provider Options |
|---------|-----------------|
| API Server | Railway, Render, Fly.io, AWS ECS |
| PostgreSQL | Supabase, Neon, Railway, RDS |
| Redis | Upstash, Railway, ElastiCache |

### Environment Variables

See `.env.example` for all required variables.

### Docker (Optional)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npx prisma generate
EXPOSE 3001
CMD ["npm", "start"]
```

## 📊 Admin Dashboard

Login: `POST /api/admin/login`
- Email: `admin@velox.com`
- Password: `velox-admin-2024`

(Change in production!)

## 🔒 Security Notes

1. Replace JWT_SECRET with strong random key
2. Configure proper CORS origins
3. Enable rate limiting in production
4. Use HTTPS only
5. Rotate Stripe webhook secrets
6. Implement proper admin authentication

## 📝 Frontend Integration

See `FRONTEND_INTEGRATION.md` for:
- API client setup
- Socket.io connection
- Authentication flow
- State management

---

Built for VeloX Rideshare © 2024
