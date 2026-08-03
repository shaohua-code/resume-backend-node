/**
 * 收藏岗位业务服务：负责简历回退、AI 匹配分析与收藏删除。
 */
const extensionJobRepo = require('../../repositories/extension-job.repository')
const resumeRepo = require('../../repositories/resume.repository')
const aiService = require('../ai/ai.service')

function businessError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode })
}

async function loadOwnedResume(userId, preferredResumeId) {
  if (preferredResumeId) {
    const preferred = await resumeRepo.findById(userId, preferredResumeId)
    if (!preferred.error && preferred.data) return preferred.data
  }

  // 旧收藏可能没有关联简历，或原简历已被删除；此时使用最近更新的一份。
  const latestResumeId = await extensionJobRepo.findLatestResumeId(userId)
  if (!latestResumeId) throw businessError('请先创建一份简历，再分析收藏岗位', 422)
  const latest = await resumeRepo.findById(userId, latestResumeId)
  if (latest.error || !latest.data) throw businessError('暂时无法读取用于分析的简历', 500)
  return latest.data
}

async function analyzeSavedJob(userId, jobId, aiOptions = {}) {
  const job = await extensionJobRepo.findById(userId, jobId)
  if (!job) throw businessError('收藏岗位不存在或已被删除', 404)
  if (String(job.jd_text || '').trim().length < 40) {
    throw businessError('该岗位缺少完整详情，请返回原招聘页重新识别后再分析', 422)
  }

  const resume = await loadOwnedResume(userId, job.resume_id)
  const { data: matchResult, meta } = await aiService.matchJd(
    resume.resume_json,
    job.jd_text,
    { ...aiOptions, userId },
  )
  const updatedJob = await extensionJobRepo.updateAnalysis(userId, jobId, resume.id, matchResult)
  if (!updatedJob) throw businessError('收藏岗位已发生变化，请刷新后重试', 409)
  return { job: updatedJob, meta }
}

async function removeSavedJob(userId, jobId) {
  const deleted = await extensionJobRepo.deleteById(userId, jobId)
  if (!deleted) throw businessError('收藏岗位不存在或已被删除', 404)
  return deleted
}

module.exports = {
  analyzeSavedJob,
  removeSavedJob,
}
