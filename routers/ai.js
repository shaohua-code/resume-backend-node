/**
 * AI 路由模块
 * 挂载路径前缀：/api/ai
 * 职责：简历事实识别、AI 简历生成、分模块优化、岗位匹配分析、简历评分
 */

const express = require('express')
const { authRequired, emailBindingRequired } = require('../middlewares/auth')
const { validate } = require('../middlewares/validate')
const aiController = require('../controllers/ai.controller')
const aiValidator = require('../validators/ai.validator')

const router = express.Router()

// 所有 AI 接口必须先登录，再由服务端确认当前账号已绑定并验证邮箱。
router.use(authRequired)
router.use(emailBindingRequired)

/**
 * AI 生成简历（同步）
 * POST /api/ai/generate
 */
router.post('/generate', aiValidator.generate, validate, aiController.generate)

/**
 * AI 生成简历（SSE 流式）
 * POST /api/ai/generate/stream
 */
router.post('/generate/stream', aiValidator.generate, validate, aiController.generateStream)

/**
 * 从自由文字中纯识别结构化简历（SSE），不生成或优化内容。
 * POST /api/ai/extract-resume/stream
 */
router.post('/extract-resume/stream', aiValidator.extractResume, validate, aiController.extractResumeStream)

/**
 * AI 优化项目描述（同步，兼容旧接口）
 * POST /api/ai/optimize
 */
router.post('/optimize', aiController.optimize)

/**
 * 基于岗位 JD 流式优化整份简历（SSE）
 * POST /api/ai/optimize-by-jd/stream
 * Body: { resume: object, jd_text: string, model?: string }
 */
router.post('/optimize-by-jd/stream', aiValidator.optimizeByJdStream, validate, aiController.optimizeByJdStream)

/**
 * 从 JD 图片提取岗位描述文本
 * POST /api/ai/extract-jd-image
 * multipart: file (image, ≤10MB)
 */
router.post('/extract-jd-image', aiController.extractJdImage)

/**
 * 从 JD 图片流式提取岗位描述文本
 * POST /api/ai/extract-jd-image/stream
 * multipart: file (image, ≤10MB)
 */
router.post('/extract-jd-image/stream', aiController.extractJdImageStream)

/**
 * 分模块 AI 流式优化
 * POST /api/ai/optimize/:type/stream
 * type 可选：summary（个人评价）、skills（技能特长）、project（项目经历）、internship（实习经历）、work_experience（工作经历）
 */
router.post('/optimize/:type/stream', aiValidator.optimizeStream, validate, aiController.optimizeStream)

/**
 * JD 岗位匹配分析
 * POST /api/ai/match
 */
router.post('/match', aiValidator.matchJd, validate, aiController.matchJd)

/**
 * AI 简历评分
 * POST /api/ai/score
 */
router.post('/score', aiValidator.score, validate, aiController.score)

/**
 * AI 绠€鍘嗚瘎鍒嗭紙SSE 娴佸紡锛?
 * POST /api/ai/score/stream
 */
router.post('/score/stream', aiValidator.score, validate, aiController.scoreStream)

module.exports = router
