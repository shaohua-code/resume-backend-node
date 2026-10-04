/** 面试题 HTTP 控制器把用户接口和管理员只读查询分开，避免权限逻辑落到前端。 */
const interviewRepo = require('../repositories/interviewQuestion.repository')
const interviewService = require('../services/interview/interviewQuestion.service')
const adminInterviewService = require('../services/admin/admin.interviewQuestion.service')
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service')
const { handleError, sanitizePublicError } = require('../utils/response')

function pageParams(query) {
  const page = Math.max(Number.parseInt(query.page || '1', 10), 1)
  const size = Math.min(Math.max(Number.parseInt(query.size || '10', 10), 1), 100)
  return { page, size }
}

async function listMySets(req, res) {
  try {
    const { page, size } = pageParams(req.query)
    const result = await interviewRepo.listSets({
      userId: req.user.id, page, size,
      keyword: String(req.query.keyword || '').trim().slice(0, 120),
      resumeId: req.query.resume_id || '', status: req.query.status || '',
      dateFrom: req.query.date_from || '', dateTo: req.query.date_to || '',
    })
    return res.json({ success: true, data: result })
  } catch (err) { return handleError(res, err) }
}

async function getMySet(req, res) {
  try {
    const result = await interviewRepo.findSet(req.user.id, req.params.setId)
    if (!result) return res.status(404).json({ success: false, detail: '面试题套题不存在' })
    return res.json({ success: true, data: result })
  } catch (err) { return handleError(res, err) }
}

async function updatePractice(req, res) {
  try {
    const practice = interviewService.normalizePractice(req.body)
    const result = await interviewRepo.updatePractice(req.user.id, req.params.setId, req.params.questionId, practice)
    if (!result) return res.status(404).json({ success: false, detail: '题目不存在或无权修改' })
    return res.json({ success: true, data: result, message: '练习记录已保存' })
  } catch (err) { return handleError(res, err) }
}

async function deleteMySet(req, res) {
  try {
    const result = await interviewRepo.deleteSet(req.user.id, req.params.setId)
    if (!result) return res.status(404).json({ success: false, detail: '套题不存在或正在生成' })
    return res.json({ success: true, message: '套题已删除' })
  } catch (err) { return handleError(res, err) }
}

// 任务查询始终以认证 user_id 为过滤条件，响应中不暴露队列内部简历/JD 请求快照。
async function getActiveGenerationJob(req, res) {
  try {
    return res.json({ success: true, data: await interviewRepo.findActiveGenerationJob(req.user.id) })
  } catch (err) { return handleError(res, err) }
}

async function listMyGenerationJobs(req, res) {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '10', 10), 1), 20)
    return res.json({ success: true, data: { items: await interviewRepo.listGenerationJobs(req.user.id, limit) } })
  } catch (err) { return handleError(res, err) }
}

async function getMyGenerationJob(req, res) {
  try {
    const result = await interviewRepo.findGenerationJob(req.user.id, req.params.jobId)
    if (!result) return res.status(404).json({ success: false, detail: '生成任务不存在或无权查看' })
    return res.json({ success: true, data: result })
  } catch (err) { return handleError(res, err) }
}

// 点评单次调用写独立 AI 审计与扣费记录；回答原文先作为点评版本快照保存。
async function createAnswerReview(req, res) {
  const userId = req.user.id
  const taskType = 'interview_answer_review'
  let review = null
  let aiStarted = false
  let callRecorded = false
  let modelMeta = null
  try {
    const answer = interviewService.normalizeReviewAnswer(req.body.answer_draft)
    const context = await interviewRepo.findQuestionReviewContext(userId, req.params.setId, req.params.questionId)
    if (!context) return res.status(404).json({ success: false, detail: '题目不存在或无权点评' })
    await ensureAiQuota(req, taskType)
    review = await interviewRepo.reserveAnswerReview(userId, req.params.setId, req.params.questionId, answer)
    if (!review) return res.status(404).json({ success: false, detail: '题目不存在或无权点评' })
    aiStarted = true

    const result = await interviewService.reviewAnswer(userId, context, answer)
    modelMeta = result.meta
    const saved = await interviewRepo.completeAnswerReview(userId, review.id, result.data)
    if (!saved) throw Object.assign(new Error('点评记录暂时无法保存，请重试'), { statusCode: 500 })
    const aiCallId = await recordAiCall(req, taskType, modelMeta.model, true, '', modelMeta)
    callRecorded = true
    await interviewRepo.linkAnswerReviewCall(userId, review.id, aiCallId)
    return res.status(201).json({ success: true, data: { ...saved, ai_call_id: aiCallId || null }, message: 'AI 点评已保存，原回答保持不变' })
  } catch (err) {
    const publicMessage = sanitizePublicError(err?.statusCode || 500, err?.message)
    modelMeta = modelMeta || err?.aiMeta || null
    if (aiStarted && !callRecorded) {
      const aiCallId = await recordAiCall(req, taskType, modelMeta?.model || '', Boolean(modelMeta), publicMessage, modelMeta || null).catch(() => null)
      callRecorded = true
      if (aiCallId && review) await interviewRepo.linkAnswerReviewCall(userId, review.id, aiCallId).catch(() => {})
    }
    if (review) await interviewRepo.failAnswerReview(userId, review.id, publicMessage).catch(() => {})
    return handleError(res, Object.assign(new Error(publicMessage), { statusCode: err?.statusCode || 500, code: err?.code }))
  }
}

// 用户可读的点评版本包含提交时回答快照；此列表不被管理员题库查询复用。
async function listAnswerReviews(req, res) {
  try {
    const context = await interviewRepo.findQuestionReviewContext(req.user.id, req.params.setId, req.params.questionId)
    if (!context) return res.status(404).json({ success: false, detail: '题目不存在或无权查看点评' })
    return res.json({ success: true, data: { items: await interviewRepo.listAnswerReviews(req.user.id, req.params.setId, req.params.questionId) } })
  } catch (err) { return handleError(res, err) }
}

async function listAdminSets(req, res) {
  try {
    const { page, size } = pageParams(req.query)
    return res.json({ success: true, data: await adminInterviewService.listSets(req, { page, size }) })
  } catch (err) { return handleError(res, err) }
}

async function getAdminSet(req, res) {
  try {
    return res.json({ success: true, data: await adminInterviewService.getSet(req, req.params.setId) })
  } catch (err) { return handleError(res, err) }
}

module.exports = {
  listMySets, getMySet, updatePractice, deleteMySet,
  getActiveGenerationJob, listMyGenerationJobs, getMyGenerationJob,
  createAnswerReview, listAnswerReviews, listAdminSets, getAdminSet,
}
