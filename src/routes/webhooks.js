/**
 * Stripe Webhooks
 * Handle payment events, transfers, etc.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post('/', async (req, res) => {
  let event;
  
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  try {
    if (webhookSecret) {
      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return res.status(400).send('Webhook Error: Missing stripe-signature header');
      }
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Stripe webhook secret is not configured' });
    } else {
      console.warn('⚠️ Processing unsigned Stripe webhook in non-production mode.');
      event = req.body;
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log('Stripe webhook:', event.type);
  
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;
        
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
        
      case 'transfer.created':
        await handleTransferCreated(event.data.object);
        break;
        
      case 'payout.paid':
        await handlePayoutPaid(event.data.object);
        break;
        
      case 'payout.failed':
        await handlePayoutFailed(event.data.object);
        break;
        
      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;
        
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
  
  res.json({ received: true });
});

async function handlePaymentSuccess(paymentIntent) {
  const rideId = paymentIntent.metadata?.rideId;
  if (!rideId) return;
  
  await prisma.ride.update({
    where: { id: rideId },
    data: { paymentStatus: 'CAPTURED', stripePaymentIntentId: paymentIntent.id }
  });
}

async function handlePaymentFailed(paymentIntent) {
  const rideId = paymentIntent.metadata?.rideId;
  if (!rideId) return;
  
  await prisma.ride.update({
    where: { id: rideId },
    data: { paymentStatus: 'FAILED' }
  });
}

async function handleTransferCreated(transfer) {
  const driverId = transfer.metadata?.driverId;
  if (!driverId) return;
  
  await prisma.payout.updateMany({
    where: { stripeTransferId: transfer.id },
    data: { status: 'PROCESSING' }
  });
}

async function handlePayoutPaid(payout) {
  // Update payout status when Stripe processes it
  await prisma.payout.updateMany({
    where: { stripePayoutId: payout.id },
    data: { status: 'COMPLETED', processedAt: new Date() }
  });
}

async function handlePayoutFailed(payout) {
  await prisma.payout.updateMany({
    where: { stripePayoutId: payout.id },
    data: { status: 'FAILED', failReason: payout.failure_message }
  });
}

async function handleAccountUpdated(account) {
  // Update driver Stripe status
  if (account.charges_enabled && account.payouts_enabled) {
    await prisma.driver.updateMany({
      where: { stripeAccountId: account.id },
      data: { stripeOnboarded: true }
    });
  }
}

module.exports = router;
