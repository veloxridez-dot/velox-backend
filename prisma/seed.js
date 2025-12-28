/**
 * Database Seed
 * Creates initial data for testing
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  
  // Create platform config
  await prisma.platformConfig.upsert({
    where: { id: 'config' },
    update: {},
    create: {
      id: 'config',
      platformCommissionPercent: 20,
      instantPayoutFeePercent: 1.5,
      instantPayoutMinAmount: 5,
      maxMatchRadiusMiles: 10,
      matchTimeoutSeconds: 30,
      pricingConfig: {
        VELOX: { baseFare: 3, perMile: 1.75, perMinute: 0.25, minFare: 7, bookingFee: 2.5 },
        VELOX_XL: { baseFare: 5, perMile: 2.5, perMinute: 0.35, minFare: 10, bookingFee: 2.5 },
        VELOX_BLACK: { baseFare: 8, perMile: 3.5, perMinute: 0.5, minFare: 15, bookingFee: 3 },
        VELOX_GREEN: { baseFare: 2.5, perMile: 1.5, perMinute: 0.2, minFare: 6, bookingFee: 2 }
      }
    }
  });
  
  // Create test riders
  const rider1 = await prisma.user.upsert({
    where: { phone: '+15551234567' },
    update: {},
    create: {
      phone: '+15551234567',
      phoneVerified: true,
      firstName: 'Alex',
      lastName: 'Demo',
      email: 'alex@example.com'
    }
  });
  console.log('✅ Created rider:', rider1.firstName);
  
  // Create test drivers
  const passwordHash = await bcrypt.hash('driver123', 12);
  
  const driver1 = await prisma.driver.upsert({
    where: { email: 'marcus@velox.com' },
    update: {},
    create: {
      email: 'marcus@velox.com',
      phone: '+15559876543',
      phoneVerified: true,
      passwordHash,
      firstName: 'Marcus',
      lastName: 'Johnson',
      vehicleMake: 'Tesla',
      vehicleModel: 'Model S',
      vehicleYear: 2023,
      vehicleColor: 'Black',
      licensePlate: 'VLX-001',
      status: 'APPROVED',
      rating: 4.95,
      totalRides: 234,
      serviceTypes: ['VELOX', 'VELOX_BLACK', 'VELOX_GREEN'],
      approvedAt: new Date()
    }
  });
  console.log('✅ Created driver:', driver1.firstName);
  
  const driver2 = await prisma.driver.upsert({
    where: { email: 'sarah@velox.com' },
    update: {},
    create: {
      email: 'sarah@velox.com',
      phone: '+15555551234',
      phoneVerified: true,
      passwordHash,
      firstName: 'Sarah',
      lastName: 'Williams',
      vehicleMake: 'Cadillac',
      vehicleModel: 'Escalade',
      vehicleYear: 2024,
      vehicleColor: 'White',
      licensePlate: 'VLX-002',
      status: 'APPROVED',
      rating: 4.88,
      totalRides: 156,
      serviceTypes: ['VELOX', 'VELOX_XL'],
      approvedAt: new Date()
    }
  });
  console.log('✅ Created driver:', driver2.firstName);
  
  // Create promo codes
  await prisma.promoCode.upsert({
    where: { code: 'FIRST10' },
    update: {},
    create: {
      code: 'FIRST10',
      type: 'FIXED',
      value: 10,
      usageLimit: 1000,
      perUserLimit: 1
    }
  });
  
  await prisma.promoCode.upsert({
    where: { code: 'VELOX25' },
    update: {},
    create: {
      code: 'VELOX25',
      type: 'PERCENTAGE',
      value: 25,
      maxDiscount: 15,
      usageLimit: 500
    }
  });
  console.log('✅ Created promo codes');
  
  console.log('🎉 Seed completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
