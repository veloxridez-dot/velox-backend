/**
 * Background Check Service
 * Checkr API integration for driver verification
 * https://docs.checkr.com/
 */

const prisma = require('../config/prisma');

const CHECKR_API_URL = 'https://api.checkr.com/v1';
const CHECKR_API_KEY = process.env.CHECKR_API_KEY;

/**
 * Create a candidate in Checkr and initiate background check
 */
async function initiateBackgroundCheck(driverId) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId }
  });
  
  if (!driver) {
    throw new Error('Driver not found');
  }
  
  if (!CHECKR_API_KEY) {
    console.warn('⚠️ Checkr not configured - using mock background check');
    return mockBackgroundCheck(driverId);
  }
  
  try {
    // Step 1: Create candidate
    const candidateResponse = await fetch(`${CHECKR_API_URL}/candidates`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(CHECKR_API_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        first_name: driver.firstName,
        last_name: driver.lastName,
        email: driver.email,
        phone: driver.phone,
        dob: driver.dateOfBirth?.toISOString().split('T')[0],
        driver_license_number: driver.driversLicenseNumber,
        driver_license_state: driver.driversLicenseState,
        custom_id: driverId
      })
    });
    
    if (!candidateResponse.ok) {
      throw new Error(`Checkr candidate creation failed: ${candidateResponse.status}`);
    }
    
    const candidate = await candidateResponse.json();
    
    // Step 2: Create invitation (or direct report)
    const reportResponse = await fetch(`${CHECKR_API_URL}/invitations`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(CHECKR_API_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        candidate_id: candidate.id,
        package: 'driver_pro' // Checkr package for rideshare drivers
      })
    });
    
    if (!reportResponse.ok) {
      throw new Error(`Checkr invitation failed: ${reportResponse.status}`);
    }
    
    const invitation = await reportResponse.json();
    
    // Update driver record
    await prisma.driver.update({
      where: { id: driverId },
      data: {
        backgroundCheckId: candidate.id,
        backgroundCheckStatus: 'IN_PROGRESS',
        backgroundCheckInviteUrl: invitation.invitation_url
      }
    });
    
    return {
      success: true,
      candidateId: candidate.id,
      invitationUrl: invitation.invitation_url,
      status: 'IN_PROGRESS'
    };
    
  } catch (err) {
    console.error('Checkr error:', err);
    throw err;
  }
}

/**
 * Handle Checkr webhook for background check updates
 */
async function handleCheckrWebhook(event) {
  const { type, data } = event;
  
  console.log('Checkr webhook:', type);
  
  switch (type) {
    case 'report.completed':
      await handleReportCompleted(data);
      break;
    case 'candidate.updated':
      // Candidate info updated
      break;
    default:
      console.log('Unhandled Checkr event:', type);
  }
}

async function handleReportCompleted(data) {
  const { id: reportId, candidate_id, status, result } = data;
  
  // Find driver by Checkr candidate ID
  const driver = await prisma.driver.findFirst({
    where: { backgroundCheckId: candidate_id }
  });
  
  if (!driver) {
    console.error('Driver not found for Checkr candidate:', candidate_id);
    return;
  }
  
  // Map Checkr status to our status
  let backgroundStatus;
  if (status === 'complete' && result === 'clear') {
    backgroundStatus = 'PASSED';
  } else if (status === 'complete' && result !== 'clear') {
    backgroundStatus = 'FAILED';
  } else {
    backgroundStatus = 'IN_PROGRESS';
  }
  
  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      backgroundCheckStatus: backgroundStatus,
      backgroundCheckReportId: reportId,
      backgroundCheckCompletedAt: new Date()
    }
  });
  
  // Auto-approve or reject based on background check
  if (backgroundStatus === 'PASSED') {
    // Check if all other requirements are met
    const canApprove = driver.driversLicense && driver.insurance && driver.vehicleRegistration;
    
    if (canApprove && driver.status === 'PENDING_APPROVAL') {
      await prisma.driver.update({
        where: { id: driver.id },
        data: { status: 'APPROVED', approvedAt: new Date() }
      });
      
      // Send push notification
      const pushService = require('./pushService');
      await pushService.notifyDriverApproved(driver.id);
    }
  } else if (backgroundStatus === 'FAILED') {
    await prisma.driver.update({
      where: { id: driver.id },
      data: { status: 'REJECTED' }
    });
    
    // TODO: Send rejection email with reason
  }
}

/**
 * Get background check status
 */
async function getBackgroundCheckStatus(driverId) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: {
      backgroundCheckId: true,
      backgroundCheckStatus: true,
      backgroundCheckCompletedAt: true
    }
  });
  
  if (!driver) {
    throw new Error('Driver not found');
  }
  
  return {
    status: driver.backgroundCheckStatus,
    checkrId: driver.backgroundCheckId,
    completedAt: driver.backgroundCheckCompletedAt
  };
}

/**
 * Mock background check for development/testing
 */
async function mockBackgroundCheck(driverId) {
  await prisma.driver.update({
    where: { id: driverId },
    data: {
      backgroundCheckId: `mock_${Date.now()}`,
      backgroundCheckStatus: 'IN_PROGRESS'
    }
  });
  
  // Simulate async completion (5 seconds in dev)
  setTimeout(async () => {
    await prisma.driver.update({
      where: { id: driverId },
      data: {
        backgroundCheckStatus: 'PASSED',
        backgroundCheckCompletedAt: new Date()
      }
    });
    console.log(`✅ Mock background check PASSED for driver ${driverId}`);
  }, 5000);
  
  return {
    success: true,
    candidateId: `mock_${Date.now()}`,
    status: 'IN_PROGRESS',
    mock: true
  };
}

module.exports = {
  initiateBackgroundCheck,
  handleCheckrWebhook,
  getBackgroundCheckStatus
};
