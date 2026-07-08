/**
 * PDF 业务服务
 * 负责 PDF 文件上传存储、文本解析、元信息读取与删除
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function getUserPdfPath(userId) {
  return path.join(UPLOAD_DIR, `${userId}.pdf`);
}

async function readPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(dataBuffer);
  return (pdfData.text || '').trim();
}

async function parsePdfFile(filePath, maxLength = 8000) {
  const text = await readPdfText(filePath);
  if (!text) {
    throw Object.assign(new Error('PDF 内容为空或无法解析（可能是扫描版图片PDF）'), { statusCode: 400 });
  }
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function getFileMeta(userId) {
  const filePath = getUserPdfPath(userId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtime: stat.mtime };
}

function deleteUserPdf(userId) {
  const filePath = getUserPdfPath(userId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function buildMulterConfig() {
  ensureUploadDir();
  const multer = require('multer');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const userId = req.user && req.user.id ? req.user.id : 'anonymous';
      cb(null, `${userId}.pdf`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
        return cb(new Error('仅支持 PDF 文件'));
      }
      cb(null, true);
    },
  });
}

module.exports = {
  UPLOAD_DIR,
  ensureUploadDir,
  getUserPdfPath,
  readPdfText,
  parsePdfFile,
  getFileMeta,
  deleteUserPdf,
  buildMulterConfig,
};
