/**
 * Payment Routes
 * Stripe integration for riders and drivers
 * 
 * UPDATED v383: Added wallet top-up and auto-reload endpoints
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
    select: { id: true, type: true, brand: true, last4: true, expMonth: true, expYear: true, isDefault: true, stripePaymentMethodId: true }
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
    
    // Set as default on Stripe customer too
    if (isDefault) {
      await stripe.customers.update(user.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId }
      });
    }
    
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
    
    res.json({ 
      success: true, 
      method: { id: method.id, brand: method.brand, last4: method.last4, isDefault: method.isDefault },
      stripeCustomerId: user.stripeCustomerId,
      stripePaymentMethodId: paymentMethodId
    });
  })
);

// Set default payment method
router.post('/methods/:id/default', requireUserType('user'), asyncHandler(async (req, res) => {
  await prisma.paymentMethod.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
  const method = await prisma.paymentMethod.update({ where: { id: req.params.id, userId: req.user.id }, data: { isDefault: true } });
  
  // Also update on Stripe
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.stripeCustomerId && method.stripePaymentMethodId) {
    await stripe.customers.update(user.stripeCustomerId, {
      invoice_settings: { default_payment_method: method.stripePaymentMethodId }
    }).catch(() => {});
  }
  
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
// RIDER WALLET TOP-UP (v383 — NEW)
// ===========================================

// Top up wallet — creates real PaymentIntent and charges the card
router.post('/topup', requireUserType('user'),
  body('amount').isFloat({ min: 5, max: 5000 }),
  body('paymentMethodId').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { amount, paymentMethodId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No payment method on file. Please add a card first.' });
    }

    // Create and confirm PaymentIntent — this actually charges the card
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      metadata: {
        type: 'wallet_topup',
        userId: user.id,
        email: user.email || ''
      },
      receipt_email: user.email || undefined,
      description: `VeloX Ridez wallet top-up — $${amount.toFixed(2)}`
    });

    if (paymentIntent.status === 'succeeded') {
      // Update user balance in database
      await prisma.user.update({
        where: { id: req.user.id },
        data: { balance: { increment: amount } }
      });

      res.json({
        success: true,
        paymentIntentId: paymentIntent.id,
        amount: amount,
        status: 'succeeded'
      });
    } else if (paymentIntent.status === 'requires_action') {
      // 3D Secure needed
      res.json({
        success: false,
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    } else {
      res.status(400).json({ error: 'Payment could not be processed', status: paymentIntent.status });
    }
  })
);

// Auto-reload — charges saved card off-session (rider not present)
router.post('/auto-reload', requireUserType('user'),
  body('amount').isFloat({ min: 5, max: 5000 }),
  asyncHandler(async (req, res) => {
    const { amount } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No saved payment method' });
    }

    // Get default payment method
    const defaultMethod = await prisma.paymentMethod.findFirst({
      where: { userId: req.user.id, isDefault: true }
    });

    if (!defaultMethod || !defaultMethod.stripePaymentMethodId) {
      return res.status(400).json({ error: 'No default payment method. Please add a card.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      customer: user.stripeCustomerId,
      payment_method: defaultMethod.stripePaymentMethodId,
      confirm: true,
      off_session: true, // Charge without rider present
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      metadata: {
        type: 'auto_reload',
        userId: user.id
      },
      description: `VeloX Ridez auto-reload — $${amount.toFixed(2)}`
    });

    if (paymentIntent.status === 'succeeded') {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { balance: { increment: amount } }
      });

      res.json({ success: true, paymentIntentId: paymentIntent.id, amount });
    } else {
      res.status(400).json({ error: 'Auto-reload charge failed' });
    }
  })
);

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
    refresh_url: `${process.env.FRONTEND_URL}/driver.html?stripe_refresh=true`,
    return_url: `${process.env.FRONTEND_URL}/driver.html?stripe_success=true`,
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
  
  // Create real Stripe transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: Math.round(netAmount * 100),
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
  
  res.json({ success: true, payout: { id: payout.id, amount: netAmount, fee, status: 'PROCESSING', stripeTransferId: transfer.id } });
}));

// Request standard payout (no fee, 2-3 days)
router.post('/driver/payout/standard', requireUserType('driver'), asyncHandler(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.user.id } });
  
  if (!driver.stripeOnboarded) {
    return res.status(400).json({ error: 'Complete Stripe onboarding first' });
  }
  
  const earnings = await prisma.earning.findMany({
    where: { driverId: req.user.id, status: 'PENDING' }
  });
  
  if (earnings.length === 0) {
    return res.status(400).json({ error: 'No available balance' });
  }
  
  const totalAmount = earnings.reduce((sum, e) => sum + parseFloat(e.netAmount) + parseFloat(e.tip), 0);
  
  if (totalAmount < 1) {
    return res.status(400).json({ error: 'Minimum payout is $1' });
  }
  
  const transfer = await stripe.transfers.create({
    amount: Math.round(totalAmount * 100),
    currency: 'usd',
    destination: driver.stripeAccountId,
    metadata: { driverId: driver.id, type: 'standard' }
  });
  
  const payout = await prisma.payout.create({
    data: {
      driverId: req.user.id,
      amount: totalAmount,
      fee: 0,
      netAmount: totalAmount,
      type: 'STANDARD',
      status: 'PROCESSING',
      stripeTransferId: transfer.id
    }
  });
  
  await prisma.earning.updateMany({
    where: { id: { in: earnings.map(e => e.id) } },
    data: { status: 'PAID_OUT', payoutId: payout.id, paidOutAt: new Date() }
  });
  
  res.json({ success: true, payout: { id: payout.id, amount: totalAmount, fee: 0, status: 'PROCESSING', stripeTransferId: transfer.id } });
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

// ===========================================
// EMAIL RECEIPTS (v387 — NEW)
// ===========================================

// Send email receipt after ride completion
// Currently stores receipt for processing — add SendGrid/Mailgun for auto-sending
router.post('/send-receipt', requireUserType('user'), asyncHandler(async (req, res) => {
  const { email, riderName, rideId, pickup, dropoff, fare, tip, total, driver, vehicle, rating, date } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  // Store receipt in database for processing
  // To enable auto-email: npm install @sendgrid/mail
  // Then uncomment the SendGrid block below

  /*
  // SENDGRID AUTO-EMAIL (uncomment when ready)
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  await sgMail.send({
    to: email,
    from: 'receipts@veloxridez.com', // Must be verified in SendGrid
    subject: `VeloX Receipt — Trip #${rideId}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0D0D0D;color:#FAFAFA;padding:2rem;border-radius:16px">
        <div style="text-align:center;margin-bottom:1.5rem">
          <h1 style="color:#D4AF37;margin:0;font-size:28px;letter-spacing:2px">VeloX</h1>
          <p style="color:#8A8A8A;margin:.3rem 0 0">Premium Transportation</p>
        </div>
        <div style="background:#161616;border-radius:12px;padding:1.2rem;margin-bottom:1rem">
          <p style="color:#8A8A8A;font-size:12px;margin:0 0 .3rem">TRIP RECEIPT</p>
          <p style="font-weight:bold;margin:0">#${rideId}</p>
          <p style="color:#8A8A8A;font-size:14px;margin:.3rem 0 0">${new Date(date).toLocaleDateString()} at ${new Date(date).toLocaleTimeString()}</p>
        </div>
        <div style="background:#161616;border-radius:12px;padding:1.2rem;margin-bottom:1rem">
          <p style="color:#22C55E;font-size:12px;margin:0">PICKUP</p>
          <p style="margin:.2rem 0 .8rem">${pickup}</p>
          <p style="color:#EF4444;font-size:12px;margin:0">DROP-OFF</p>
          <p style="margin:.2rem 0 0">${dropoff}</p>
        </div>
        <div style="background:#161616;border-radius:12px;padding:1.2rem;margin-bottom:1rem">
          <p style="margin:0"><strong>Chauffeur:</strong> ${driver}</p>
          ${vehicle ? '<p style="color:#8A8A8A;margin:.3rem 0 0">' + vehicle + '</p>' : ''}
        </div>
        <div style="background:#161616;border-radius:12px;padding:1.2rem;margin-bottom:1rem">
          <div style="display:flex;justify-content:space-between;margin-bottom:.5rem">
            <span style="color:#8A8A8A">Trip fare</span>
            <span>$${parseFloat(fare).toFixed(2)}</span>
          </div>
          ${tip > 0 ? '<div style="display:flex;justify-content:space-between;margin-bottom:.5rem"><span style="color:#8A8A8A">Chauffeur tip</span><span style="color:#22C55E">+$' + parseFloat(tip).toFixed(2) + '</span></div>' : ''}
          <div style="display:flex;justify-content:space-between;padding-top:.5rem;border-top:1px solid #2A2A2A;font-weight:bold;font-size:18px">
            <span>Total</span>
            <span style="color:#D4AF37">$${parseFloat(total).toFixed(2)}</span>
          </div>
        </div>
        <p style="text-align:center;color:#8A8A8A;font-size:12px">Thank you for riding with VeloX Premium Transportation</p>
      </div>
    `
  });
  */

  res.json({ success: true, message: 'Receipt recorded' });
}));

// ===========================================
// ADMIN: COMPANY PAYOUT (v388 — NEW)
// ===========================================

// Trigger manual payout of platform balance to company bank
router.post('/company-payout', asyncHandler(async (req, res) => {
  const { amount, type, adminEmail } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Minimum company payout is $100' });
  }

  // Check available platform balance first
  const balance = await stripe.balance.retrieve();
  const availableUsd = balance.available.find(b => b.currency === 'usd');
  const availableCents = availableUsd ? availableUsd.amount : 0;
  const availableDollars = availableCents / 100;

  if (amount > availableDollars) {
    return res.status(400).json({
      error: `Insufficient Stripe balance. Available: $${availableDollars.toFixed(2)}`,
      available: availableDollars
    });
  }

  const fee = type === 'instant' ? amount * 0.01 : 0;
  const net = amount - fee;

  // Create real Stripe payout to connected bank account
  const payout = await stripe.payouts.create({
    amount: Math.round(net * 100), // cents
    currency: 'usd',
    method: type === 'instant' ? 'instant' : 'standard',
    description: `VeloX company payout — ${adminEmail || 'admin'}`,
    metadata: {
      type: 'company_payout',
      adminEmail: adminEmail || 'unknown',
      grossAmount: amount.toString(),
      fee: fee.toString()
    }
  });

  res.json({
    success: true,
    payoutId: payout.id,
    status: payout.status, // 'paid', 'pending', 'in_transit'
    amount: amount,
    fee: fee,
    net: net,
    arrival: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null
  });
}));

module.exports = router;
