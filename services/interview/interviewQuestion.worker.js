/** 持久化题目生成 worker：任务跨越 HTTP 请求生命周期，并在服务重启后可追踪恢复。 */
const interviewRepo = require('../../repositories/interviewQuestion.repository')
const interviewService = require('./interviewQuestion.service')
const { ensureAiQuota, recordAiCall } = require('../ai/ai.quota.service')
const { sanitizePublicError, BUSY_MESSAGE } = require('../../utils/response')

const TASK_TYPE = 'interview_questions'
const POLL_INTERVAL_MS = 2000
const HEARTBEAT_INTERVAL_MS = 30000
let started = false
let processing = false
let lastQueueErrorAt = 0

function toPublicFailure(error) {
  const statusCode = Number(error?.statusCode) || 500
  const safe = sanitizePublicError(statusCode, error?.message)
  return safe === BUSY_MESSAGE ? '题目生成遇到问题，请检查模型配置与网络后重试。' : safe
}

// Worker 使用服务端从 users 表读取的角色字段进行余额校验和调用审计，不读取客户端声明。
async function processJob(job) {
  const userId = job.user_id
  const setId = job.set_id
  const request = { user: { id: userId, role: job.user_role || 'USER' } }
  let aiStarted = false
  let callRecorded = false
  let modelMeta = null
  let operationQueue = Promise.resolve()
  let aiCallId = null
  const heartbeat = setInterval(() => {
    interviewRepo.heartbeatGenerationJob(job.id, userId).catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)

  try {
    await interviewRepo.updateGenerationStage(job.id, userId, 'quota_check', '正在检查余额和题目生成模型配置')
    await ensureAiQuota(request, TASK_TYPE)
    const payload = typeof job.request_payload === 'string' ? JSON.parse(job.request_payload) : job.request_payload
    if (!payload || !payload.resumeJson || !payload.questionCount) {
      throw Object.assign(new Error('生成任务上下文不完整，请重新发起'), { statusCode: 400 })
    }

    aiStarted = true
    const { data, meta } = await interviewService.generateQuestionsStream(
      userId,
      payload,
      { avoidHistory: Boolean(payload.avoidHistory) },
      (question, index) => {
        // 解析器只回调完整且字段有效的 JSON 题目；写入队列保持原始生成顺序。
        operationQueue = operationQueue.then(() => interviewRepo.appendQuestionProgress(job.id, userId, setId, question, index))
      },
      (stage, status) => {
        // 仅储存代码定义的任务阶段和状态文案，不输出模型内部推理内容。
        operationQueue = operationQueue.then(() => interviewRepo.updateGenerationStage(job.id, userId, stage, status))
      },
    )
    modelMeta = meta
    await operationQueue

    await interviewRepo.updateGenerationStage(job.id, userId, 'validating', '题目已生成，正在校验完整结果')
    await interviewRepo.completeSet(userId, setId, data.questions, { deferCompletion: true })
    await interviewRepo.updateGenerationStage(job.id, userId, 'saving', '题目通过校验，正在保存 AI 调用记录和题库')
    aiCallId = await recordAiCall(request, TASK_TYPE, meta.model, true, '', meta)
    callRecorded = true
    await interviewRepo.linkAiCall(userId, setId, aiCallId)
    await interviewRepo.finishGenerationJob(job.id, userId, setId, data.questions.length, aiCallId)
  } catch (error) {
    const publicMessage = toPublicFailure(error)
    modelMeta = modelMeta || error?.aiMeta || null
    // 外部模型已成功返回时按实际用量记录；其它异常记为失败且不扣费、不自动重放。
    if (aiStarted && !callRecorded) {
      aiCallId = await recordAiCall(request, TASK_TYPE, modelMeta?.model || '', Boolean(modelMeta), publicMessage, modelMeta || null).catch(() => null)
      callRecorded = true
    }
    if (aiCallId) {
      await interviewRepo.linkAiCall(userId, setId, aiCallId).catch(() => {})
      await interviewRepo.linkGenerationJobCall(job.id, userId, aiCallId).catch(() => {})
    }
    await interviewRepo.failGenerationJob(job.id, userId, setId, publicMessage).catch(() => {})
  } finally {
    clearInterval(heartbeat)
  }
}

// 数据库任务表是跨实例队列；SKIP LOCKED 保证同一任务只由一个 worker 执行。
async function tick() {
  if (processing) return
  processing = true
  try {
    await interviewRepo.failStaleGenerationJobs()
    const job = await interviewRepo.claimNextGenerationJob()
    if (job) await processJob(job)
  } catch (error) {
    // 数据迁移尚未应用或数据库短暂不可达时节流日志，避免 worker 每轮刷屏。
    if (Date.now() - lastQueueErrorAt > 60000) {
      lastQueueErrorAt = Date.now()
      console.error('[interview-question-worker] 队列暂不可用，请检查数据库结构与连接。')
    }
  } finally {
    processing = false
  }
}

function startInterviewQuestionWorker() {
  if (started) return
  started = true
  const timer = setInterval(tick, POLL_INTERVAL_MS)
  timer.unref?.()
  tick().catch(() => {})
}

module.exports = { startInterviewQuestionWorker }
