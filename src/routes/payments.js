/**
 * Payment Routes
 * Stripe integration for riders and drivers
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireUserType } = require('../middleware/auth');

// Initialize Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ===========================================
// RIDER PAYMENT METHODS
// ===========================================

// Get payment methods
router.get('/methods', requireUserType('user'), asyncHandler(async (req, res) => {
  const methods = await prisma.paymentMethod.findMany({
    where: { userId: req.user.id },
    select: { id: true, type: true, brand: true, last4: true, expMonth: true, expYear: true, isDefault: true }
  });
  res.json({ methods });
}));

// Add payment method
router.post('/methods', requireUserType('user'),
  body('paymentMethodId').notEmpty(),
  asyncHandler(async (req, res) => {
    const { paymentMethodId } = req.body;
    
    // Get user's Stripe customer ID or create one
    let user = await prisma.user.findUnique({ where: { id: req.user.id } });
    
    if (!user.stripeCustomerId) {
      const customer = await stripe.customers.create({
        phone: user.phone,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        metadata: { veloxUserId: user.id }
      });
      
      user = await prisma.user.update({
        where: { id: req.user.id },
        data: { stripeCustomerId: customer.id }
      });
    }
    
    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, { customer: user.stripeCustomerId });
    
    // Get payment method details
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    
    // Check if this should be default
    const existingMethods = await prisma.paymentMethod.count({ where: { userId: req.user.id } });
    const isDefault = existingMethods === 0;
    
    // Save to database
    const method = await prisma.paymentMethod.create({
      data: {
        userId: req.user.id,
        type: pm.type === 'card' ? 'CARD' : 'CARD',
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
        stripePaymentMethodId: paymentMethodId,
        isDefault
      }
    });
    
    res.json({ success: true, method: { id: method.id, brand: method.brand, last4: method.last4, isDefault: method.isDefault } });
  })
);

// Set default payment method
router.post('/methods/:id/default', requireUserType('user'), asyncHandler(async (req, res) => {
  await prisma.paymentMethod.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
  await prisma.paymentMethod.update({ where: { id: req.params.id, userId: req.user.id }, data: { isDefault: true } });
  res.json({ success: true });
}));

// Delete payment method
router.delete('/methods/:id', requireUserType('user'), asyncHandler(async (req, res) => {
  const method = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!method) return res.status(404).json({ error: 'Payment method not found' });
  
  // Detach from Stripe
  if (method.stripePaymentMethodId) {
    await stripe.paymentMethods.detach(method.stripePaymentMethodId).catch(() => {});
  }
  
  await prisma.paymentMethod.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ===========================================
// DRIVER STRIPE CONNECT
// ===========================================

// Create Stripe Connect onboarding link
router.post('/driver/connect/onboard', requireUserType('driver'), asyncHandler(async (req, res) => {
  let driver = await prisma.driver.findUnique({ where: { id: req.user.id } });
  
  // Create Stripe Connect account if not exists
  if (!driver.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: driver.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: 'individual',
      metadata: { veloxDriverId: driver.id }
    });
    
    driver = await prisma.driver.update({
      where: { id: req.user.id },
      data: { stripeAccountId: account.id }
    });
  }
  
  // Create onboarding link
  const accountLink = await stripe.accountLinks.create({
    account: driver.stripeAccountId,
    refresh_url: `${process.env.FRONTEND_URL}/driver/payments?refresh=true`,
    return_url: `${process.env.FRONTEND_URL}/driver/payments?success=true`,
    type: 'account_onboarding'
  });
  
  res.json({ url: accountLink.url });
}));

// Check Connect account status
router.get('/driver/connect/status', requireUserType('driver'), asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.user.id } });
  
  if (!driver.stripeAccountId) {
    return res.json({ status: 'not_started', onboarded: false });
  }
  
  const account = await stripe.accounts.retrieve(driver.stripeAccountId);
  
  const onboarded = account.charges_enabled && account.payouts_enabled;
  
  if (onboarded && !driver.stripeOnboarded) {
    await prisma.driver.update({ where: { id: req.user.id }, data: { stripeOnboarded: true } });
  }
  
  res.json({
    status: onboarded ? 'complete' : 'pending',
    onboarded,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    requirements: account.requirements
  });
}));

// ===========================================
// DRIVER PAYOUTS
// ===========================================

// Get available balance
router.get('/driver/balance', requireUserType('driver'), asyncHandler(async (req, res) => {
  const earnings = await prisma.earning.aggregate({
    where: { driverId: req.user.id, status: 'PENDING' },
    _sum: { netAmount: true, tip: true }
  });
  
  const available = parseFloat(earnings._sum.netAmount || 0) + parseFloat(earnings._sum.tip || 0);
  
  res.json({ available, currency: 'usd' });
}));

// Request instant payout
router.post('/driver/payout/instant', requireUserType('driver'), asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.user.id } });
  
  if (!driver.stripeOnboarded) {
    return res.status(400).json({ error: 'Complete Stripe onboarding first' });
  }
  
  // Get pending earnings
  const earnings = await prisma.earning.findMany({
    where: { driverId: req.user.id, status: 'PENDING' }
  });
  
  if (earnings.length === 0) {
    return res.status(400).json({ error: 'No available balance' });
  }
  
  const totalAmount = earnings.reduce((sum, e) => sum + parseFloat(e.netAmount) + parseFloat(e.tip), 0);
  
  // Instant payout fee (1.5%)
  const fee = totalAmount * 0.015;
  const netAmount = totalAmount - fee;
  
  if (netAmount < 5) {
    return res.status(400).json({ error: 'Minimum payout is $5' });
  }
  
  // Create transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: Math.round(netAmount * 100), // cents
    currency: 'usd',
    destination: driver.stripeAccountId,
    metadata: { driverId: driver.id, type: 'instant' }
  });
  
  // Create payout record
  const payout = await prisma.payout.create({
    data: {
      driverId: req.user.id,
      amount: totalAmount,
      fee,
      netAmount,
      type: 'INSTANT',
      status: 'PROCESSING',
      stripeTransferId: transfer.id
    }
  });
  
  // Mark earnings as paid
  await prisma.earning.updateMany({
    where: { id: { in: earnings.map(e => e.id) } },
    data: { status: 'PAID_OUT', payoutId: payout.id, paidOutAt: new Date() }
  });
  
  res.json({ success: true, payout: { id: payout.id, amount: netAmount, fee, status: 'PROCESSING' } });
}));

// Get payout history
router.get('/driver/payouts', requireUserType('driver'), asyncHandler(async (req, res) => {
  const payouts = await prisma.payout.findMany({
    where: { driverId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  
  res.json({
    payouts: payouts.map(p => ({
      id: p.id,
      amount: parseFloat(p.amount),
      fee: parseFloat(p.fee),
      netAmount: parseFloat(p.netAmount),
      type: p.type,
      status: p.status,
      createdAt: p.createdAt,
      processedAt: p.processedAt
    }))
  });
}));

module.exports = router;
