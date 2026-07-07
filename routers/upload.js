/**
 * 统一文件上传路由
 * 支持图片、PDF、常见文档，供头像、反馈富文本、其他业务共用
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { authRequired } = require('../middlewares/auth');

const router = express.Router();

const UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads');
const FILES_DIR = path.join(UPLOAD_ROOT, 'files');

if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// 允许上传的 MIME 白名单
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx',
]);

function sanitizeExt(originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  return ALLOWED_EXT.has(ext) ? ext : '';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || 'anonymous';
    const userDir = path.join(FILES_DIR, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const ext = sanitizeExt(file.originalname) || '.bin';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = sanitizeExt(file.originalname);
    if (!ext || !ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error('不支持的文件类型'));
    }
    cb(null, true);
  },
});

router.use(authRequired);

/**
 * POST /api/upload/file
 * multipart field: file
 */
router.post('/file', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ detail: err.message || '上传失败' });
    }
    if (!req.file) {
      return res.status(400).json({ detail: '请选择要上传的文件' });
    }

    const userId = req.user?.id || 'anonymous';
    const relativePath = `/uploads/files/${userId}/${req.file.filename}`;

    return res.json({
      success: true,
      data: {
        url: relativePath,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  });
});

module.exports = router;
