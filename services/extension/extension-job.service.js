/**
 * 收藏岗位业务服务：负责简历回退、AI 匹配分析与收藏删除。
 */
const extensionJobRepo = require('../../repositories/extension-job.repository')
const resumeRepo = require('../../repositories/resume.repository')
const aiService = require('../ai/ai.service')
const db = require('../../lib/db')
const { recordServerEvent } = require('../productEvents/productEvents.service')

const APPLICATION_STAGES = new Set([
  'saved', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived',
])

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

// 求职进度输入经过白名单与日期校验后才交由仓储事务保存，备注只用于用户自己的时间线。
async function updateJobProgress(userId, jobId, input = {}) {
  const stage = String(input.application_stage || '').trim()
  if (!APPLICATION_STAGES.has(stage)) throw businessError('请选择有效的求职阶段', 400)

  const normalizeDate = (value, label) => {
    if (value === '' || value == null) return null
    const text = String(value).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw businessError(`${label}格式无效`, 400)
    const date = new Date(`${text}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
      throw businessError(`${label}日期无效`, 400)
    }
    return text
  }

  const progress = {
    application_stage: stage,
    applied_at: input.applied_at === undefined ? undefined : normalizeDate(input.applied_at, '投递日期'),
    next_action_at: input.next_action_at === undefined ? undefined : normalizeDate(input.next_action_at, '下一步日期'),
    progress_note: input.progress_note === undefined
      ? undefined
      : String(input.progress_note ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .trim()
        .slice(0, 1000),
  }
  if (input.career_goal_id !== undefined) {
    const rawGoalId = input.career_goal_id
    if (rawGoalId === null || rawGoalId === '') {
      progress.career_goal_id = null
    } else {
      const goalId = Number(rawGoalId)
      if (!Number.isSafeInteger(goalId) || goalId < 1) throw businessError('求职目标无效', 400)
      const { rows } = await db.query(
        'SELECT id FROM public.career_goal WHERE id=$1 AND user_id=$2 AND status = \'active\' LIMIT 1',
        [goalId, userId],
      )
      if (!rows.length) throw businessError('求职目标不存在或已完成', 400)
      progress.career_goal_id = goalId
    }
  }
  const result = await extensionJobRepo.updateProgress(userId, jobId, progress)
  if (!result) throw businessError('收藏岗位不存在或已被删除', 404)
  const job = result.job
  if (result.fromStage !== job.application_stage) {
    void recordServerEvent(userId, 'job_stage_changed', {
      from_stage: result.fromStage,
      to_stage: job.application_stage,
      has_next_action_date: job.next_action_at ? 'true' : 'false',
    }).catch(() => {})
  }
  return job
}

// 历史只在岗位归属验证通过后返回；不存在和不归属统一表现为 404。
async function getJobProgressHistory(userId, jobId) {
  const history = await extensionJobRepo.findProgressHistory(userId, jobId)
  if (!history) throw businessError('收藏岗位不存在或已被删除', 404)
  return history
}

module.exports = {
  analyzeSavedJob,
  removeSavedJob,
  updateJobProgress,
  getJobProgressHistory,
}
