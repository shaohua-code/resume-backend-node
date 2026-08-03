/**
 * 浏览器 Agent 网页端收藏控制器。
 */
const extensionJobService = require('../services/extension/extension-job.service')
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service')
const { success, error, sanitizePublicError } = require('../utils/response')

function requestedModel(req) {
  return String(req.body?.model || '').trim()
}

function parseJobId(req) {
  const jobId = Number(req.params.jobId)
  return Number.isSafeInteger(jobId) && jobId > 0 ? jobId : null
}

function respondAnalyzeError(res, err) {
  if (err.code === 'AI_LIMIT_EXCEEDED') return error(res, 403, err.message)
  if (err.code === 'INSUFFICIENT_BALANCE') return error(res, 402, err.message, { code: err.code })
  if (err.code === 'CONFIG_MISSING') return error(res, 400, err.message)
  const statusCode = err.statusCode || 500
  return error(res, statusCode, sanitizePublicError(statusCode, err.message))
}

async function analyzeSavedJob(req, res) {
  const taskType = 'jd_match'
  const model = requestedModel(req)
  const jobId = parseJobId(req)
  if (!jobId) return error(res, 400, '岗位编号无效')
  try {
    await ensureAiQuota(req, taskType)
    const { job, meta } = await extensionJobService.analyzeSavedJob(
      req.user.id,
      jobId,
      { model },
    )
    await recordAiCall(req, taskType, model, true, '', meta)
    return success(res, { job }, '岗位分析完成')
  } catch (err) {
    await recordAiCall(req, taskType, model, false, err.message)
    return respondAnalyzeError(res, err)
  }
}

async function removeSavedJob(req, res) {
  const jobId = parseJobId(req)
  if (!jobId) return error(res, 400, '岗位编号无效')
  try {
    const deleted = await extensionJobService.removeSavedJob(req.user.id, jobId)
    return success(res, { id: deleted.id }, '已取消收藏')
  } catch (err) {
    const statusCode = err.statusCode || 500
    return error(res, statusCode, sanitizePublicError(statusCode, err.message))
  }
}

module.exports = {
  analyzeSavedJob,
  removeSavedJob,
}
