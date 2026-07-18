/**
 * PDF 路由模块
 * 挂载路径前缀：/api/pdf
 * 职责：PDF 上传、事实识别、AI 整体优化、已上传文件管理
 */

const express = require('express')
const { authRequired, emailBindingRequired } = require('../middlewares/auth')
const { validate } = require('../middlewares/validate')
const pdfController = require('../controllers/pdf.controller')
const pdfValidator = require('../validators/pdf.validator')

const router = express.Router()

// 所有 PDF 接口都需要登录
router.use(authRequired)

/**
 * 上传 PDF 并由 AI 同步优化
 * POST /api/pdf/uploadOptimize
 */
router.post('/uploadOptimize', emailBindingRequired, pdfValidator.uploadOptimize, validate, pdfController.uploadOptimize)

/**
 * 上传 PDF 并由 AI 流式优化（SSE）
 * POST /api/pdf/uploadOptimize/stream
 */
router.post('/uploadOptimize/stream', emailBindingRequired, pdfValidator.uploadOptimize, validate, pdfController.uploadOptimizeStream)

/**
 * 上传 PDF 并纯识别结构化简历（SSE），不执行任何优化。
 * POST /api/pdf/uploadRecognize/stream
 */
router.post('/uploadRecognize/stream', emailBindingRequired, pdfController.uploadRecognizeStream)

/**
 * 使用已上传 PDF 进行 AI 同步优化
 * POST /api/pdf/uploadOptimize/existing
 */
router.post('/uploadOptimize/existing', emailBindingRequired, pdfValidator.existingOptimize, validate, pdfController.existingOptimize)

/**
 * 使用已上传 PDF 进行 AI 流式优化（SSE）
 * POST /api/pdf/uploadOptimize/existing/stream
 */
router.post('/uploadOptimize/existing/stream', emailBindingRequired, pdfValidator.existingOptimize, validate, pdfController.existingOptimizeStream)

/**
 * 上传 PDF 并由 AI 根据岗位 JD 流式优化（SSE）
 * POST /api/pdf/uploadOptimizeByJd/stream
 */
router.post('/uploadOptimizeByJd/stream', emailBindingRequired, pdfValidator.uploadOptimizeByJd, validate, pdfController.uploadOptimizeByJdStream)

/**
 * 使用已上传 PDF 根据岗位 JD 流式优化（SSE）
 * POST /api/pdf/uploadOptimizeByJd/existing/stream
 */
router.post('/uploadOptimizeByJd/existing/stream', emailBindingRequired, pdfValidator.existingOptimizeByJd, validate, pdfController.existingOptimizeByJdStream)

/**
 * 获取当前用户已上传 PDF 元信息
 * GET /api/pdf/uploadedFile
 */
router.get('/uploadedFile', pdfController.uploadedFileMeta)

/**
 * 删除当前用户已上传 PDF
 * DELETE /api/pdf/uploadedFile
 */
router.delete('/uploadedFile', pdfController.deleteUploadedFile)

module.exports = router
