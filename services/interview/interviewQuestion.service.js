/** 面试题业务服务校验简历及岗位归属，并把生成上下文限制在求职所需信息。 */
const db = require('../../lib/db')
const resumeRepo = require('../../repositories/resume.repository')
const interviewRepo = require('../../repositories/interviewQuestion.repository')

function parseResume(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '{}')) } catch { throw Object.assign(new Error('简历内容无法读取，请先重新保存简历'), { statusCode: 400 }) }
}

function makeResumeSnapshot(resume) {
  // 模型需要经历证据，但题库快照不保存电话、邮箱、头像等无关个人标识。
  const fields = ['target_position', 'summary', 'educations', 'projects', 'internships', 'work_experiences', 'skills', 'awards', 'certificates']
  return Object.fromEntries(fields.filter((key) => resume[key] !== undefined).map((key) => [key, resume[key]]))
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

async function prepareContext(userId, body = {}) {
  const resumeId = Number(body.resume_id)
  if (!Number.isSafeInteger(resumeId) || resumeId < 1) throw Object.assign(new Error('请选择有效简历'), { statusCode: 400 })
  const { data: resumeRow } = await resumeRepo.findById(userId, resumeId)
  if (!resumeRow) throw Object.assign(new Error('简历不存在或无权访问'), { statusCode: 404 })
  const resume = parseResume(resumeRow.resume_json)
  let goal = null
  let job = null
  const careerGoalId = body.career_goal_id ? Number(body.career_goal_id) : null
  const savedJobId = body.saved_job_id ? Number(body.saved_job_id) : null
  if (careerGoalId) {
    const { rows } = await db.query(
      `SELECT id,name,job_direction,status FROM public.career_goal
       WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [careerGoalId, userId],
    )
    if (!rows.length) throw Object.assign(new Error('求职目标不存在或无权访问'), { statusCode: 404 })
    if (rows[0].status !== 'active') throw Object.assign(new Error('请选择进行中的求职目标'), { statusCode: 400 })
    goal = rows[0]
  }
  if (savedJobId) {
    const { rows } = await db.query(
      `SELECT id,title,jd_text,career_goal_id FROM public.extension_saved_job
       WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [savedJobId, userId],
    )
    if (!rows.length) throw Object.assign(new Error('收藏岗位不存在或无权访问'), { statusCode: 404 })
    job = rows[0]
  }
  const targetPosition = cleanText(body.target_position || job?.title || goal?.job_direction || goal?.name || resume.target_position, 160)
  if (!targetPosition) throw Object.assign(new Error('请填写目标岗位'), { statusCode: 400 })
  const jdText = cleanText(body.jd_text || job?.jd_text, 12000)
  const categories = Array.isArray(body.categories) ? [...new Set(body.categories)] : []
  const questionCount = Number(body.question_count || 10)
  const modelResume = makeResumeSnapshot(resume)
  return {
    resumeId,
    careerGoalId: careerGoalId || goal?.id || null,
    savedJobId: savedJobId || job?.id || null,
    targetPosition,
    jdText,
    categories,
    questionCount,
    resumeJson: modelResume,
    resumeSnapshot: modelResume,
  }
}

async function generateQuestions(userId, context, options = {}) {
  const avoidQuestions = options.avoidHistory ? await interviewRepo.listRecentQuestions(userId) : []
  const aiService = require('../ai/ai.service')
  return aiService.generateInterviewQuestions({ ...context, avoidQuestions }, { userId })
}

// 流式与普通生成共用历史题目过滤和用户级模型配置，避免两条链路上下文不一致。
async function generateQuestionsStream(userId, context, options = {}, onQuestion, onStatus) {
  const avoidQuestions = options.avoidHistory ? await interviewRepo.listRecentQuestions(userId) : []
  const aiService = require('../ai/ai.service')
  return aiService.generateInterviewQuestionsStream({ ...context, avoidQuestions }, { userId }, onQuestion, onStatus)
}

// AI 点评必须收到用户显式提交的回答原文；此处仅做长度/空白校验，不替用户改写。
function normalizeReviewAnswer(value) {
  const answer = cleanText(value, 20000)
  if (!answer) throw Object.assign(new Error('请先填写你的面试回答，再请求 AI 点评'), { statusCode: 400 })
  return answer
}

// 点评上下文从本人已保存题目和生成快照取证据，不能接受客户端伪造的简历或岗位信息。
async function reviewAnswer(userId, context, answer) {
  const aiService = require('../ai/ai.service')
  return aiService.reviewInterviewAnswer({
    question: context.question,
    evaluationFocus: context.evaluation_focus,
    targetPosition: context.target_position,
    jdText: context.jd_snapshot,
    resumeEvidence: {
      questionEvidence: context.resume_evidence,
      resumeSnapshot: context.resume_snapshot,
    },
    answer,
  }, { userId })
}

function normalizePractice(input = {}) {
  const status = String(input.status || '')
  if (!['todo', 'practiced', 'mastered'].includes(status)) {
    throw Object.assign(new Error('练习状态无效'), { statusCode: 400 })
  }
  return {
    status,
    answerDraft: cleanText(input.answer_draft, 20000),
    reflection: cleanText(input.reflection, 8000),
  }
}

module.exports = { prepareContext, generateQuestions, generateQuestionsStream, normalizePractice, normalizeReviewAnswer, reviewAnswer }
