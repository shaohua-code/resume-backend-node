/**
 * 简历源文件业务服务
 * 负责 PDF / Word(.docx) 上传存储、文本解析、元信息读取与删除
 */

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')
const {
  ensureUploadDirs,
  getUserPdfPath,
  findUserResumeFile,
  getUserResumePathByExt,
  clearUserResumeOtherExts,
  RESUME_FILE_EXTENSIONS,
  PDFS_DIR,
} = require('../../lib/uploadPaths')

// 识别/优化共用上限：旧值 8000 会截掉后半段经历，导致「识别不完整」
const DEFAULT_PDF_TEXT_MAX_LENGTH = 50000

/** 允许的 MIME（部分浏览器对 docx 为空或给 octet-stream，扩展名再兜底） */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
])

function ensureUploadDir() {
  ensureUploadDirs()
}

/**
 * 从原始文件名解析小写扩展名（含点号）
 * @param {string} originalName
 */
function resolveUploadExt(originalName) {
  const lower = String(originalName || '').toLowerCase()
  if (lower.endsWith('.docx')) return '.docx'
  if (lower.endsWith('.pdf')) return '.pdf'
  return ''
}

/**
 * 校验上传文件是否为 PDF 或 Word(.docx)；旧版 .doc 单独提示
 * @param {{ mimetype?: string, originalname?: string }} file
 */
function assertAllowedResumeFile(file) {
  const name = String(file?.originalname || '').toLowerCase()
  const mime = String(file?.mimetype || '').toLowerCase()
  if (name.endsWith('.doc') && !name.endsWith('.docx')) {
    const err = new Error('暂不支持旧版 .doc，请另存为 .docx 后上传')
    err.statusCode = 400
    throw err
  }
  const ext = resolveUploadExt(name)
  if (!RESUME_FILE_EXTENSIONS.includes(ext)) {
    const err = new Error('仅支持 PDF 或 Word（.docx）文件')
    err.statusCode = 400
    throw err
  }
  // octet-stream 仅在扩展名合法时放行
  if (mime && !ALLOWED_MIME.has(mime) && !mime.includes('pdf') && !mime.includes('word') && !mime.includes('officedocument')) {
    const err = new Error('仅支持 PDF 或 Word（.docx）文件')
    err.statusCode = 400
    throw err
  }
  return ext
}

async function readPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath)
  const pdfData = await pdfParse(dataBuffer)
  return (pdfData.text || '').trim()
}

/** 用 mammoth 抽取 .docx 纯文本 */
async function readDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath })
  return String(result?.value || '').trim()
}

/**
 * 解析简历源文件文本（PDF 或 DOCX）。
 * @param {string} filePath
 * @param {number} maxLength 安全上限；传 0 表示不截断（仍受模型上下文约束）
 */
async function parsePdfFile(filePath, maxLength = DEFAULT_PDF_TEXT_MAX_LENGTH) {
  const ext = path.extname(filePath || '').toLowerCase()
  let text = ''
  if (ext === '.docx') {
    try {
      text = await readDocxText(filePath)
    } catch (e) {
      throw Object.assign(new Error('Word 文档无法解析，请确认文件未损坏且为 .docx 格式'), {
        statusCode: 400,
        cause: e,
      })
    }
    if (!text) {
      throw Object.assign(new Error('Word 文档内容为空或无法提取文字'), { statusCode: 400 })
    }
  } else {
    text = await readPdfText(filePath)
    if (!text) {
      throw Object.assign(new Error('PDF 内容为空或无法解析（可能是扫描版图片PDF）'), { statusCode: 400 })
    }
  }
  // maxLength<=0：保留全文，避免长简历后半段进不了模型
  if (!maxLength || maxLength <= 0 || text.length <= maxLength) return text
  return text.slice(0, maxLength)
}

function getFileMeta(userId) {
  const found = findUserResumeFile(userId)
  if (!found) return null
  const stat = fs.statSync(found.filePath)
  return {
    size: stat.size,
    mtime: stat.mtime,
    // 便于前端区分预览方式
    ext: found.ext,
    filename: path.basename(found.filePath),
  }
}

function deleteUserPdf(userId) {
  // 删除该用户所有受支持扩展名的源文件
  for (const ext of RESUME_FILE_EXTENSIONS) {
    const filePath = getUserResumePathByExt(userId, ext)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
}

function buildMulterConfig() {
  ensureUploadDir()
  const multer = require('multer')
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PDFS_DIR),
    filename: (req, file, cb) => {
      try {
        const userId = req.user && req.user.id ? req.user.id : 'anonymous'
        const ext = assertAllowedResumeFile(file)
        // 换格式上传时清掉另一扩展名，保证每人只有一份
        clearUserResumeOtherExts(userId, ext)
        cb(null, `${userId}${ext}`)
      } catch (e) {
        cb(e)
      }
    },
  })
  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      try {
        assertAllowedResumeFile(file)
        cb(null, true)
      } catch (e) {
        cb(e)
      }
    },
  })
}

/** 按扩展名返回预览用 Content-Type 与下载文件名 */
function getResumeContentHeaders(filePath) {
  const ext = path.extname(filePath || '').toLowerCase()
  if (ext === '.docx') {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      disposition: 'attachment; filename="resume.docx"',
    }
  }
  return {
    contentType: 'application/pdf',
    disposition: 'inline; filename="resume.pdf"',
  }
}

module.exports = {
  ensureUploadDir,
  getUserPdfPath,
  findUserResumeFile,
  readPdfText,
  parsePdfFile,
  getFileMeta,
  deleteUserPdf,
  buildMulterConfig,
  getResumeContentHeaders,
  DEFAULT_PDF_TEXT_MAX_LENGTH,
}
