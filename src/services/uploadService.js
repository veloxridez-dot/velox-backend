/**
 * Document Upload Service
 * Handles driver document uploads (license, insurance, registration)
 * Supports AWS S3, Google Cloud Storage, or local filesystem
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const prisma = require('../config/prisma');

// Storage configuration
const STORAGE_TYPE = process.env.STORAGE_TYPE || 'local'; // 's3', 'gcs', or 'local'
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// AWS S3 setup (if using S3)
let s3Client = null;
if (STORAGE_TYPE === 's3' && process.env.AWS_ACCESS_KEY_ID) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
}

/**
 * Upload a document
 */
async function uploadDocument(driverId, documentType, fileBuffer, mimeType, originalName) {
  // Validate file
  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new Error(`Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
  }
  
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }
  
  // Generate unique filename
  const ext = path.extname(originalName) || '.jpg';
  const filename = `${driverId}/${documentType}_${uuidv4()}${ext}`;
  
  let url;
  
  if (STORAGE_TYPE === 's3' && s3Client) {
    url = await uploadToS3(filename, fileBuffer, mimeType);
  } else {
    url = await uploadToLocal(filename, fileBuffer);
  }
  
  // Save document record to database
  const document = await prisma.driverDocument.create({
    data: {
      driverId,
      type: documentType,
      filename,
      originalName,
      mimeType,
      size: fileBuffer.length,
      url,
      status: 'PENDING_REVIEW'
    }
  });
  
  // Update driver record with document URL
  const updateField = getDriverField(documentType);
  if (updateField) {
    await prisma.driver.update({
      where: { id: driverId },
      data: { [updateField]: url }
    });
  }
  
  return {
    id: document.id,
    type: documentType,
    url,
    status: 'PENDING_REVIEW'
  };
}

/**
 * Upload to AWS S3
 */
async function uploadToS3(filename, buffer, mimeType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: `documents/${filename}`,
    Body: buffer,
    ContentType: mimeType,
    ACL: 'private' // Documents should not be publicly accessible
  });
  
  await s3Client.send(command);
  
  return `s3://${process.env.S3_BUCKET}/documents/${filename}`;
}

/**
 * Upload to local filesystem
 */
async function uploadToLocal(filename, buffer) {
  const filePath = path.join(UPLOAD_DIR, 'documents', filename);
  const dir = path.dirname(filePath);
  
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, buffer);
  
  return `/uploads/documents/${filename}`;
}

/**
 * Get signed URL for private document access
 */
async function getDocumentUrl(documentId, expiresIn = 3600) {
  const document = await prisma.driverDocument.findUnique({
    where: { id: documentId }
  });
  
  if (!document) {
    throw new Error('Document not found');
  }
  
  if (STORAGE_TYPE === 's3' && s3Client) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: document.url.replace(`s3://${process.env.S3_BUCKET}/`, '')
    });
    
    return getSignedUrl(s3Client, command, { expiresIn });
  }
  
  // For local storage, return direct URL (should be protected by auth middleware)
  return document.url;
}

/**
 * Delete a document
 */
async function deleteDocument(documentId) {
  const document = await prisma.driverDocument.findUnique({
    where: { id: documentId }
  });
  
  if (!document) {
    throw new Error('Document not found');
  }
  
  // Delete from storage
  if (STORAGE_TYPE === 's3' && s3Client) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    
    const command = new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: document.url.replace(`s3://${process.env.S3_BUCKET}/`, '')
    });
    
    await s3Client.send(command);
  } else {
    const filePath = path.join(UPLOAD_DIR, document.url.replace('/uploads/', ''));
    await fs.unlink(filePath).catch(() => {});
  }
  
  // Delete database record
  await prisma.driverDocument.delete({
    where: { id: documentId }
  });
  
  return { success: true };
}

/**
 * Get all documents for a driver
 */
async function getDriverDocuments(driverId) {
  return prisma.driverDocument.findMany({
    where: { driverId },
    orderBy: { createdAt: 'desc' }
  });
}

/**
 * Review/approve a document (admin only)
 */
async function reviewDocument(documentId, status, reviewNotes = null, reviewerId = null) {
  const validStatuses = ['APPROVED', 'REJECTED', 'PENDING_REVIEW'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }
  
  const document = await prisma.driverDocument.update({
    where: { id: documentId },
    data: {
      status,
      reviewedAt: new Date(),
      reviewNotes,
      reviewerId
    }
  });
  
  // If document rejected, update driver record
  if (status === 'REJECTED') {
    const updateField = getDriverField(document.type);
    if (updateField) {
      await prisma.driver.update({
        where: { id: document.driverId },
        data: { [updateField]: null }
      });
    }
  }
  
  return document;
}

/**
 * Check if driver has all required documents approved
 */
async function checkDocumentRequirements(driverId) {
  const requiredTypes = ['DRIVERS_LICENSE', 'INSURANCE', 'VEHICLE_REGISTRATION'];
  
  const documents = await prisma.driverDocument.findMany({
    where: {
      driverId,
      type: { in: requiredTypes },
      status: 'APPROVED'
    }
  });
  
  const approvedTypes = documents.map(d => d.type);
  const missing = requiredTypes.filter(t => !approvedTypes.includes(t));
  
  return {
    complete: missing.length === 0,
    approved: approvedTypes,
    missing
  };
}

/**
 * Map document type to driver field
 */
function getDriverField(documentType) {
  const mapping = {
    'DRIVERS_LICENSE': 'driversLicense',
    'INSURANCE': 'insurance',
    'VEHICLE_REGISTRATION': 'vehicleRegistration',
    'VEHICLE_PHOTO': 'vehiclePhoto',
    'PROFILE_PHOTO': 'avatarUrl'
  };
  return mapping[documentType];
}

module.exports = {
  uploadDocument,
  getDocumentUrl,
  deleteDocument,
  getDriverDocuments,
  reviewDocument,
  checkDocumentRequirements,
  ALLOWED_TYPES,
  MAX_FILE_SIZE
};
