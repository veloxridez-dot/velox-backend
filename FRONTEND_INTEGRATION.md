# Frontend Integration Guide

How to connect the VeloX frontend to the backend API.

## 1. API Configuration

Add to your frontend config:

```javascript
// config.js
const API_URL = 'http://localhost:3001/api';  // Development
// const API_URL = 'https://api.velox.com/api';  // Production

const SOCKET_URL = 'http://localhost:3001';
```

## 2. HTTP Client Setup

```javascript
// api.js
class VeloxAPI {
  constructor() {
    this.baseUrl = API_URL;
    this.token = localStorage.getItem('velox_token');
  }
  
  setToken(token) {
    this.token = token;
    localStorage.setItem('velox_token', token);
  }
  
  clearToken() {
    this.token = null;
    localStorage.removeItem('velox_token');
  }
  
  async request(method, endpoint, data = null) {
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    const options = { method, headers };
    if (data) {
      options.body = JSON.stringify(data);
    }
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    const json = await response.json();
    
    if (!response.ok) {
      throw new Error(json.error || 'Request failed');
    }
    
    return json;
  }
  
  // Auth
  async sendCode(phone) {
    return this.request('POST', '/auth/rider/send-code', { phone });
  }
  
  async verifyCode(phone, code, firstName, lastName) {
    const result = await this.request('POST', '/auth/rider/verify-code', { phone, code, firstName, lastName });
    if (result.accessToken) {
      this.setToken(result.accessToken);
    }
    return result;
  }
  
  // Rides
  async getFareEstimate(pickup, dropoff, stops = []) {
    return this.request('POST', '/rides/estimate', {
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      stops
    });
  }
  
  async requestRide(data) {
    return this.request('POST', '/rides/request', data);
  }
  
  async getRide(id) {
    return this.request('GET', `/rides/${id}`);
  }
  
  async cancelRide(id, reason) {
    return this.request('POST', `/rides/${id}/cancel`, { reason });
  }
  
  async addTip(id, amount) {
    return this.request('POST', `/rides/${id}/tip`, { amount });
  }
  
  async rateRide(id, rating, comment) {
    return this.request('POST', `/rides/${id}/rate`, { rating, comment });
  }
  
  async getRideHistory(limit = 20, offset = 0) {
    return this.request('GET', `/rides?limit=${limit}&offset=${offset}`);
  }
  
  // Profile
  async getProfile() {
    return this.request('GET', '/users/me');
  }
  
  async updateProfile(data) {
    return this.request('PATCH', '/users/me', data);
  }
  
  // Payment Methods
  async getPaymentMethods() {
    return this.request('GET', '/payments/methods');
  }
  
  async addPaymentMethod(paymentMethodId) {
    return this.request('POST', '/payments/methods', { paymentMethodId });
  }
}

const api = new VeloxAPI();
export default api;
```

## 3. Socket.io Connection

```javascript
// socket.js
import { io } from 'socket.io-client';

let socket = null;

export function connectSocket(token) {
  if (socket?.connected) return socket;
  
  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket']
  });
  
  socket.on('connect', () => {
    console.log('Socket connected');
  });
  
  socket.on('disconnect', () => {
    console.log('Socket disconnected');
  });
  
  socket.on('connect_error', (error) => {
    console.error('Socket error:', error.message);
  });
  
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getSocket() {
  return socket;
}
```

## 4. Ride Tracking Example

```javascript
// RideTracker.js
import { getSocket } from './socket';
import api from './api';

class RideTracker {
  constructor() {
    this.currentRide = null;
    this.listeners = [];
  }
  
  async requestRide(pickup, dropoff, serviceType, paymentMethodId) {
    const result = await api.requestRide({
      pickupAddress: pickup.address,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffAddress: dropoff.address,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      serviceType,
      paymentMethodId
    });
    
    this.currentRide = result.ride;
    this.subscribeToRide(result.ride.id);
    
    return result.ride;
  }
  
  subscribeToRide(rideId) {
    const socket = getSocket();
    if (!socket) return;
    
    socket.emit('ride:subscribe', { rideId });
    
    socket.on('ride:accepted', (data) => {
      this.currentRide.status = 'ACCEPTED';
      this.currentRide.driver = data.driver;
      this.notify('accepted', data);
    });
    
    socket.on('driver:location_update', (data) => {
      if (this.currentRide?.driver) {
        this.currentRide.driver.location = { lat: data.lat, lng: data.lng };
      }
      this.notify('location', data);
    });
    
    socket.on('ride:driver_arrived', (data) => {
      this.currentRide.status = 'ARRIVED';
      this.notify('arrived', data);
    });
    
    socket.on('ride:trip_started', (data) => {
      this.currentRide.status = 'IN_PROGRESS';
      this.notify('started', data);
    });
    
    socket.on('ride:completed', (data) => {
      this.currentRide.status = 'COMPLETED';
      this.notify('completed', data);
    });
    
    socket.on('ride:cancelled', (data) => {
      this.currentRide.status = 'CANCELLED';
      this.notify('cancelled', data);
    });
    
    socket.on('ride:no_drivers', (data) => {
      this.currentRide.status = 'NO_DRIVERS';
      this.notify('no_drivers', data);
    });
  }
  
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }
  
  notify(event, data) {
    this.listeners.forEach(l => l(event, data));
  }
}

export default new RideTracker();
```

## 5. Driver App Socket Events

```javascript
// DriverSocket.js
import { getSocket } from './socket';

class DriverSocket {
  goOnline(lat, lng) {
    const socket = getSocket();
    socket.emit('driver:online', { lat, lng });
  }
  
  goOffline() {
    const socket = getSocket();
    socket.emit('driver:offline');
  }
  
  updateLocation(lat, lng, rideId = null) {
    const socket = getSocket();
    socket.emit('driver:location', { lat, lng, rideId });
  }
  
  acceptRide(rideId) {
    const socket = getSocket();
    socket.emit('driver:accept_ride', { rideId });
  }
  
  arrivedAtPickup(rideId) {
    const socket = getSocket();
    socket.emit('driver:arrived', { rideId });
  }
  
  startTrip(rideId) {
    const socket = getSocket();
    socket.emit('driver:start_trip', { rideId });
  }
  
  completeTrip(rideId) {
    const socket = getSocket();
    socket.emit('driver:complete_trip', { rideId });
  }
  
  // Listen for ride requests
  onRideRequest(callback) {
    const socket = getSocket();
    socket.on('ride:request', callback);
  }
}

export default new DriverSocket();
```

## 6. Stripe Payment Setup

```html
<!-- In your HTML -->
<script src="https://js.stripe.com/v3/"></script>
```

```javascript
// Payment.js
const stripe = Stripe('pk_test_YOUR_KEY');

async function addPaymentMethod() {
  // Create card element
  const elements = stripe.elements();
  const cardElement = elements.create('card');
  cardElement.mount('#card-element');
  
  // On submit
  const { paymentMethod, error } = await stripe.createPaymentMethod({
    type: 'card',
    card: cardElement
  });
  
  if (error) {
    throw error;
  }
  
  // Send to backend
  await api.addPaymentMethod(paymentMethod.id);
}
```

## 7. Replace Demo Mode

In your existing frontend, replace the demo mode code:

```javascript
// BEFORE (Demo)
if (APP.demoMode) {
  simulateDriverMovement();
}

// AFTER (Real)
import rideTracker from './RideTracker';

rideTracker.subscribe((event, data) => {
  switch (event) {
    case 'accepted':
      // Show driver info
      showDriverCard(data.driver);
      break;
    case 'location':
      // Update driver marker on map
      updateDriverMarker(data.lat, data.lng);
      break;
    case 'arrived':
      // Show "Driver arrived" notification
      showNotification('Your driver has arrived!');
      break;
    case 'started':
      // Update UI to trip mode
      showTripProgress();
      break;
    case 'completed':
      // Show rating screen
      showRatingScreen(data);
      break;
  }
});
```

## 8. Environment Detection

```javascript
// config.js
export const IS_DEMO = !process.env.VELOX_API_URL;

export const API_URL = IS_DEMO 
  ? null  // Use localStorage sync
  : process.env.VELOX_API_URL;

// In your app
if (IS_DEMO) {
  // Use existing localStorage sync
  localStorage.setItem(RIDE_CHANNEL, JSON.stringify(data));
} else {
  // Use real API
  await api.requestRide(data);
}
```

This allows the app to work in both demo mode (no backend) and production mode (with backend).

---

For questions, check the API documentation or contact the backend team.
