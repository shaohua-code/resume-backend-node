/**
 * PDF 业务服务
 * 负责 PDF 文件上传存储、文本解析、元信息读取与删除
 */

const fs = require('fs')
const pdfParse = require('pdf-parse')
const {
  ensureUploadDirs,
  getUserPdfPath,
  PDFS_DIR,
} = require('../../lib/uploadPaths')

// 识别/优化共用上限：旧值 8000 会截掉后半段经历，导致「识别不完整」
const DEFAULT_PDF_TEXT_MAX_LENGTH = 50000

function ensureUploadDir() {
  ensureUploadDirs()
}

async function readPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath)
  const pdfData = await pdfParse(dataBuffer)
  return (pdfData.text || '').trim()
}

/**
 * 解析 PDF 文本。
 * @param {string} filePath
 * @param {number} maxLength 安全上限；传 0 表示不截断（仍受模型上下文约束）
 */
async function parsePdfFile(filePath, maxLength = DEFAULT_PDF_TEXT_MAX_LENGTH) {
  const text = await readPdfText(filePath)
  if (!text) {
    throw Object.assign(new Error('PDF 内容为空或无法解析（可能是扫描版图片PDF）'), { statusCode: 400 })
  }
  // maxLength<=0：保留全文，避免长简历后半段进不了模型
  if (!maxLength || maxLength <= 0 || text.length <= maxLength) return text
  return text.slice(0, maxLength)
}

function getFileMeta(userId) {
  const filePath = getUserPdfPath(userId)
  if (!fs.existsSync(filePath)) {
    return null
  }
  const stat = fs.statSync(filePath)
  return { size: stat.size, mtime: stat.mtime }
}

function deleteUserPdf(userId) {
  const filePath = getUserPdfPath(userId)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

function buildMulterConfig() {
  ensureUploadDir()
  const multer = require('multer')
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PDFS_DIR),
    filename: (req, file, cb) => {
      const userId = req.user && req.user.id ? req.user.id : 'anonymous'
      cb(null, `${userId}.pdf`)
    },
  })
  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
        return cb(new Error('仅支持 PDF 文件'))
      }
      cb(null, true)
    },
  })
}

module.exports = {
  ensureUploadDir,
  getUserPdfPath,
  readPdfText,
  parsePdfFile,
  getFileMeta,
  deleteUserPdf,
  buildMulterConfig,
  DEFAULT_PDF_TEXT_MAX_LENGTH,
}
