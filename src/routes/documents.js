/**
 * Document Upload Routes
 * Driver document management
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken, requireUserType } = require('../middleware/auth');
const uploadService = require('../services/uploadService');
const backgroundCheckService = require('../services/backgroundCheckService');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadService.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (uploadService.ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${uploadService.ALLOWED_TYPES.join(', ')}`));
    }
  }
});

// Upload a document
router.post('/', 
  authenticateToken, 
  requireUserType('driver'),
  upload.single('document'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { type } = req.body;
    if (!type) {
      return res.status(400).json({ error: 'Document type required' });
    }
    
    const result = await uploadService.uploadDocument(
      req.user.id,
      type,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    
    res.json({ success: true, document: result });
  })
);

// Get all documents for current driver
router.get('/', 
  authenticateToken, 
  requireUserType('driver'),
  asyncHandler(async (req, res) => {
    const documents = await uploadService.getDriverDocuments(req.user.id);
    const requirements = await uploadService.checkDocumentRequirements(req.user.id);
    
    res.json({ documents, requirements });
  })
);

// Get signed URL for a document
router.get('/:id/url', 
  authenticateToken,
  asyncHandler(async (req, res) => {
    const url = await uploadService.getDocumentUrl(req.params.id);
    res.json({ url });
  })
);

// Delete a document
router.delete('/:id', 
  authenticateToken, 
  requireUserType('driver'),
  asyncHandler(async (req, res) => {
    await uploadService.deleteDocument(req.params.id);
    res.json({ success: true });
  })
);

// Initiate background check
router.post('/background-check', 
  authenticateToken, 
  requireUserType('driver'),
  asyncHandler(async (req, res) => {
    const result = await backgroundCheckService.initiateBackgroundCheck(req.user.id);
    res.json(result);
  })
);

// Get background check status
router.get('/background-check/status', 
  authenticateToken, 
  requireUserType('driver'),
  asyncHandler(async (req, res) => {
    const status = await backgroundCheckService.getBackgroundCheckStatus(req.user.id);
    res.json(status);
  })
);

module.exports = router;
