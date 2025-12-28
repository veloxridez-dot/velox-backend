/**
 * Email & Receipt Service
 * Handles transactional emails and PDF receipt generation
 */

const prisma = require('../config/prisma');

// Email provider - supports SendGrid, Postmark, or Nodemailer
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'console'; // 'sendgrid', 'postmark', 'smtp', 'console'

let emailClient = null;

// Initialize email client
function initEmailClient() {
  if (emailClient) return emailClient;
  
  switch (EMAIL_PROVIDER) {
    case 'sendgrid':
      if (process.env.SENDGRID_API_KEY) {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        emailClient = sgMail;
      }
      break;
    case 'postmark':
      if (process.env.POSTMARK_API_KEY) {
        const postmark = require('postmark');
        emailClient = new postmark.ServerClient(process.env.POSTMARK_API_KEY);
      }
      break;
    case 'smtp':
      if (process.env.SMTP_HOST) {
        const nodemailer = require('nodemailer');
        emailClient = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });
      }
      break;
    default:
      // Console logging for development
      emailClient = {
        send: async (msg) => {
          console.log('📧 Email (dev mode):');
          console.log(`  To: ${msg.to}`);
          console.log(`  Subject: ${msg.subject}`);
          console.log(`  Preview: ${msg.text?.substring(0, 100)}...`);
          return { success: true, mock: true };
        }
      };
  }
  
  return emailClient;
}

/**
 * Send email
 */
async function sendEmail({ to, subject, text, html, attachments = [] }) {
  const client = initEmailClient();
  
  if (!client) {
    console.warn('⚠️ Email client not configured');
    return { success: false, error: 'Email not configured' };
  }
  
  const fromEmail = process.env.FROM_EMAIL || 'noreply@velox.com';
  const fromName = process.env.FROM_NAME || 'VeloX';
  
  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      await client.send({
        to,
        from: { email: fromEmail, name: fromName },
        subject,
        text,
        html,
        attachments: attachments.map(a => ({
          content: a.content.toString('base64'),
          filename: a.filename,
          type: a.contentType
        }))
      });
    } else if (EMAIL_PROVIDER === 'postmark') {
      await client.sendEmail({
        From: `${fromName} <${fromEmail}>`,
        To: to,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        Attachments: attachments.map(a => ({
          Name: a.filename,
          Content: a.content.toString('base64'),
          ContentType: a.contentType
        }))
      });
    } else if (EMAIL_PROVIDER === 'smtp') {
      await client.sendMail({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        text,
        html,
        attachments
      });
    } else {
      await client.send({ to, subject, text });
    }
    
    return { success: true };
  } catch (err) {
    console.error('Email send error:', err);
    return { success: false, error: err.message };
  }
}

// ===========================================
// RIDE RECEIPT
// ===========================================

async function sendRideReceipt(rideId) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      user: true,
      driver: true,
      stops: true
    }
  });
  
  if (!ride || !ride.user.email) {
    return { success: false, error: 'Ride not found or user has no email' };
  }
  
  const receiptHtml = generateRideReceiptHtml(ride);
  const receiptText = generateRideReceiptText(ride);
  
  // Generate PDF receipt
  const pdfBuffer = await generateReceiptPdf(ride);
  
  return sendEmail({
    to: ride.user.email,
    subject: `Your VeloX Receipt - $${parseFloat(ride.totalFare).toFixed(2)}`,
    text: receiptText,
    html: receiptHtml,
    attachments: pdfBuffer ? [{
      filename: `velox-receipt-${ride.id.slice(0, 8)}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf'
    }] : []
  });
}

function generateRideReceiptHtml(ride) {
  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #000; color: #C9A227; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
    .amount { font-size: 36px; font-weight: bold; text-align: center; margin: 20px 0; }
    .route { background: #fff; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .route-point { display: flex; align-items: flex-start; gap: 12px; margin: 10px 0; }
    .route-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
    .pickup-dot { background: #22C55E; }
    .dropoff-dot { background: #EF4444; }
    .breakdown { margin: 20px 0; }
    .breakdown-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
    .breakdown-row:last-child { border-bottom: none; font-weight: bold; }
    .driver { display: flex; align-items: center; gap: 15px; background: #fff; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .driver-avatar { width: 50px; height: 50px; background: #C9A227; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20px; font-weight: bold; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>VeloX</h1>
    <p style="margin: 5px 0 0; opacity: 0.8;">Receipt</p>
  </div>
  <div class="content">
    <div class="amount">$${parseFloat(ride.totalFare).toFixed(2)}</div>
    <p style="text-align: center; color: #666;">${formatDate(ride.completedAt || ride.createdAt)}</p>
    
    <div class="route">
      <div class="route-point">
        <div class="route-dot pickup-dot"></div>
        <div>${ride.pickupAddress}</div>
      </div>
      ${ride.stops.map(s => `
        <div class="route-point">
          <div class="route-dot" style="background: #C9A227;"></div>
          <div>${s.address}</div>
        </div>
      `).join('')}
      <div class="route-point">
        <div class="route-dot dropoff-dot"></div>
        <div>${ride.dropoffAddress}</div>
      </div>
    </div>
    
    <div class="breakdown">
      <div class="breakdown-row"><span>Base fare</span><span>$${parseFloat(ride.baseFare).toFixed(2)}</span></div>
      <div class="breakdown-row"><span>Distance (${ride.distanceMiles?.toFixed(1)} mi)</span><span>$${parseFloat(ride.distanceFare).toFixed(2)}</span></div>
      <div class="breakdown-row"><span>Time (${ride.durationMinutes} min)</span><span>$${parseFloat(ride.timeFare).toFixed(2)}</span></div>
      ${ride.surgeMult > 1 ? `<div class="breakdown-row"><span>Surge (${ride.surgeMult}x)</span><span>Applied</span></div>` : ''}
      ${parseFloat(ride.promoDiscount) > 0 ? `<div class="breakdown-row"><span>Promo discount</span><span>-$${parseFloat(ride.promoDiscount).toFixed(2)}</span></div>` : ''}
      ${parseFloat(ride.tip) > 0 ? `<div class="breakdown-row"><span>Tip</span><span>$${parseFloat(ride.tip).toFixed(2)}</span></div>` : ''}
      <div class="breakdown-row"><span>Total</span><span>$${(parseFloat(ride.totalFare) + parseFloat(ride.tip)).toFixed(2)}</span></div>
    </div>
    
    ${ride.driver ? `
    <div class="driver">
      <div class="driver-avatar">${ride.driver.firstName.charAt(0)}</div>
      <div>
        <strong>${ride.driver.firstName} ${ride.driver.lastName.charAt(0)}.</strong>
        <br><span style="color: #666;">${ride.driver.vehicleColor} ${ride.driver.vehicleMake} ${ride.driver.vehicleModel}</span>
        <br><span style="color: #666;">${ride.driver.licensePlate}</span>
      </div>
    </div>
    ` : ''}
    
    <div class="footer">
      <p>Thank you for riding with VeloX!</p>
      <p>Ride ID: ${ride.id}</p>
      <p>Questions? Contact support@velox.com</p>
    </div>
  </div>
</body>
</html>
  `;
}

function generateRideReceiptText(ride) {
  return `
VeloX Receipt
==============

Total: $${parseFloat(ride.totalFare).toFixed(2)}
Date: ${new Date(ride.completedAt || ride.createdAt).toLocaleString()}

Route:
- Pickup: ${ride.pickupAddress}
- Dropoff: ${ride.dropoffAddress}

Fare Breakdown:
- Base fare: $${parseFloat(ride.baseFare).toFixed(2)}
- Distance: $${parseFloat(ride.distanceFare).toFixed(2)}
- Time: $${parseFloat(ride.timeFare).toFixed(2)}
${parseFloat(ride.tip) > 0 ? `- Tip: $${parseFloat(ride.tip).toFixed(2)}` : ''}

${ride.driver ? `Driver: ${ride.driver.firstName} ${ride.driver.lastName.charAt(0)}.` : ''}

Ride ID: ${ride.id}
Thank you for riding with VeloX!
  `.trim();
}

/**
 * Generate PDF receipt
 */
async function generateReceiptPdf(ride) {
  // Using PDFKit for PDF generation
  try {
    const PDFDocument = require('pdfkit');
    
    return new Promise((resolve) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      
      // Header
      doc.fillColor('#C9A227')
         .fontSize(28)
         .text('VeloX', { align: 'center' });
      doc.fillColor('#666')
         .fontSize(12)
         .text('Receipt', { align: 'center' });
      doc.moveDown(2);
      
      // Amount
      doc.fillColor('#000')
         .fontSize(36)
         .text(`$${parseFloat(ride.totalFare).toFixed(2)}`, { align: 'center' });
      doc.fillColor('#666')
         .fontSize(10)
         .text(new Date(ride.completedAt || ride.createdAt).toLocaleString(), { align: 'center' });
      doc.moveDown(2);
      
      // Route
      doc.fillColor('#22C55E')
         .fontSize(10)
         .text('●', { continued: true })
         .fillColor('#000')
         .text(` ${ride.pickupAddress}`);
      doc.moveDown(0.5);
      doc.fillColor('#EF4444')
         .text('●', { continued: true })
         .fillColor('#000')
         .text(` ${ride.dropoffAddress}`);
      doc.moveDown(2);
      
      // Breakdown
      doc.fontSize(12).text('Fare Breakdown', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10);
      doc.text(`Base fare: $${parseFloat(ride.baseFare).toFixed(2)}`);
      doc.text(`Distance (${ride.distanceMiles?.toFixed(1)} mi): $${parseFloat(ride.distanceFare).toFixed(2)}`);
      doc.text(`Time (${ride.durationMinutes} min): $${parseFloat(ride.timeFare).toFixed(2)}`);
      if (parseFloat(ride.tip) > 0) {
        doc.text(`Tip: $${parseFloat(ride.tip).toFixed(2)}`);
      }
      doc.moveDown();
      doc.fontSize(12).text(`Total: $${(parseFloat(ride.totalFare) + parseFloat(ride.tip)).toFixed(2)}`, { bold: true });
      
      // Footer
      doc.moveDown(3);
      doc.fillColor('#666')
         .fontSize(8)
         .text(`Ride ID: ${ride.id}`, { align: 'center' });
      doc.text('Thank you for riding with VeloX!', { align: 'center' });
      
      doc.end();
    });
  } catch (err) {
    console.warn('PDF generation not available:', err.message);
    return null;
  }
}

// ===========================================
// DRIVER EARNINGS STATEMENT
// ===========================================

async function sendDriverEarningsStatement(driverId, periodStart, periodEnd) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId }
  });
  
  if (!driver?.email) {
    return { success: false, error: 'Driver has no email' };
  }
  
  const earnings = await prisma.earning.findMany({
    where: {
      driverId,
      createdAt: { gte: periodStart, lte: periodEnd }
    },
    include: { ride: true },
    orderBy: { createdAt: 'desc' }
  });
  
  const totals = earnings.reduce((acc, e) => ({
    gross: acc.gross + parseFloat(e.grossAmount),
    fees: acc.fees + parseFloat(e.platformFee),
    net: acc.net + parseFloat(e.netAmount),
    tips: acc.tips + parseFloat(e.tip)
  }), { gross: 0, fees: 0, net: 0, tips: 0 });
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #000; color: #C9A227; padding: 20px; text-align: center; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
    .total { font-weight: bold; background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="header">
    <h1>VeloX</h1>
    <p>Earnings Statement</p>
  </div>
  <p>Period: ${periodStart.toLocaleDateString()} - ${periodEnd.toLocaleDateString()}</p>
  <p>Driver: ${driver.firstName} ${driver.lastName}</p>
  
  <table>
    <tr><th>Rides Completed</th><td>${earnings.length}</td></tr>
    <tr><th>Gross Earnings</th><td>$${totals.gross.toFixed(2)}</td></tr>
    <tr><th>Platform Fees</th><td>-$${totals.fees.toFixed(2)}</td></tr>
    <tr><th>Tips</th><td>$${totals.tips.toFixed(2)}</td></tr>
    <tr class="total"><th>Net Earnings</th><td>$${(totals.net + totals.tips).toFixed(2)}</td></tr>
  </table>
</body>
</html>
  `;
  
  return sendEmail({
    to: driver.email,
    subject: `VeloX Earnings Statement - ${periodStart.toLocaleDateString()} to ${periodEnd.toLocaleDateString()}`,
    html,
    text: `Your VeloX earnings: $${(totals.net + totals.tips).toFixed(2)} from ${earnings.length} rides.`
  });
}

// ===========================================
// OTHER EMAIL TEMPLATES
// ===========================================

async function sendWelcomeEmail(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) return { success: false };
  
  return sendEmail({
    to: user.email,
    subject: 'Welcome to VeloX! 🚗',
    html: `
      <h1>Welcome to VeloX!</h1>
      <p>Hi ${user.firstName},</p>
      <p>Thank you for joining VeloX. Your premium ride awaits.</p>
      <p>Use code <strong>FIRST10</strong> for $10 off your first ride!</p>
    `,
    text: `Welcome to VeloX! Use code FIRST10 for $10 off your first ride.`
  });
}

async function sendDriverWelcomeEmail(driverId) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver?.email) return { success: false };
  
  return sendEmail({
    to: driver.email,
    subject: 'Welcome to VeloX Driver! 🎉',
    html: `
      <h1>Welcome to VeloX!</h1>
      <p>Hi ${driver.firstName},</p>
      <p>Your driver application has been approved. You can now start accepting rides and earning with VeloX.</p>
      <p>Tips for success:</p>
      <ul>
        <li>Keep your car clean and presentable</li>
        <li>Be friendly and professional</li>
        <li>Follow GPS directions carefully</li>
        <li>Accept rides promptly during peak hours</li>
      </ul>
      <p>Happy driving!</p>
    `
  });
}

module.exports = {
  sendEmail,
  sendRideReceipt,
  sendDriverEarningsStatement,
  sendWelcomeEmail,
  sendDriverWelcomeEmail
};
