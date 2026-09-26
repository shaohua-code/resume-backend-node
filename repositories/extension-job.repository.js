/**
 * 浏览器 Agent 收藏岗位仓库。
 * 只负责用户隔离的数据读取与写入，不承载 AI 或 HTTP 语义。
 */
const db = require('../lib/db')

const DETAIL_FIELDS = `
  id, source_url, source_platform, source_original, title, company, location, address,
  salary, skills, jd_text, resume_id, match_result, status, application_stage,
  applied_at, next_action_at, progress_note, career_goal_id, create_time, update_time
`

async function findById(userId, jobId) {
  const { rows } = await db.query(
    `SELECT ${DETAIL_FIELDS}
     FROM public.extension_saved_job
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [jobId, userId],
  )
  return rows[0] || null
}

async function findLatestResumeId(userId) {
  const { rows } = await db.query(
    `SELECT id
     FROM public.resume
     WHERE user_id = $1
     ORDER BY update_time DESC, id DESC
     LIMIT 1`,
    [userId],
  )
  return rows[0]?.id || null
}

async function updateAnalysis(userId, jobId, resumeId, matchResult) {
  const { rows } = await db.query(
    `UPDATE public.extension_saved_job
     SET resume_id = $3,
         match_result = $4::jsonb,
         status = 'ready',
         update_time = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${DETAIL_FIELDS}`,
    [jobId, userId, resumeId, JSON.stringify(matchResult || {})],
  )
  return rows[0] || null
}

async function deleteById(userId, jobId) {
  const { rows } = await db.query(
    `DELETE FROM public.extension_saved_job
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [jobId, userId],
  )
  return rows[0] || null
}

// 阶段、日期和备注以当前用户为边界更新；阶段变更与历史记录在同一事务提交。
async function updateProgress(userId, jobId, progress) {
  const client = await db.getPool().connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const { rows: currentRows } = await client.query(
      `SELECT id, application_stage, applied_at, next_action_at, progress_note, career_goal_id
       FROM public.extension_saved_job
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [jobId, userId],
    )
    if (!currentRows.length) {
      await client.query('COMMIT')
      transactionOpen = false
      return null
    }

    const currentStage = currentRows[0].application_stage
    // PATCH 未传入的选填字段沿用当前值；显式空值仍可用于清除日期或备注。
    const nextProgress = {
      application_stage: progress.application_stage,
      applied_at: progress.applied_at === undefined ? currentRows[0].applied_at : progress.applied_at,
      next_action_at: progress.next_action_at === undefined ? currentRows[0].next_action_at : progress.next_action_at,
      progress_note: progress.progress_note === undefined ? currentRows[0].progress_note : progress.progress_note,
      career_goal_id: progress.career_goal_id === undefined ? currentRows[0].career_goal_id : progress.career_goal_id,
    }
    const { rows } = await client.query(
      `UPDATE public.extension_saved_job
       SET application_stage = $3,
           applied_at = $4,
           next_action_at = $5,
           progress_note = $6,
           career_goal_id = $7,
           update_time = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${DETAIL_FIELDS}`,
      [jobId, userId, nextProgress.application_stage, nextProgress.applied_at, nextProgress.next_action_at, nextProgress.progress_note, nextProgress.career_goal_id],
    )
    if (currentStage !== nextProgress.application_stage) {
      await client.query(
        `INSERT INTO public.extension_job_progress_history
           (user_id, job_id, from_stage, to_stage, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, jobId, currentStage, nextProgress.application_stage, nextProgress.progress_note],
      )
    }
    await client.query('COMMIT')
    transactionOpen = false
    return rows[0] || null
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// 时间线查询同时限定用户与岗位，避免仅凭可猜测的岗位编号读取其他账号记录。
async function findProgressHistory(userId, jobId) {
  const { rows: jobs } = await db.query(
    'SELECT id FROM public.extension_saved_job WHERE id = $1 AND user_id = $2 LIMIT 1',
    [jobId, userId],
  )
  if (!jobs.length) return null
  const { rows } = await db.query(
    `SELECT id, from_stage, to_stage, note, create_time
     FROM public.extension_job_progress_history
     WHERE job_id = $1 AND user_id = $2
     ORDER BY create_time DESC, id DESC`,
    [jobId, userId],
  )
  return rows
}

module.exports = {
  findById,
  findLatestResumeId,
  updateAnalysis,
  updateProgress,
  findProgressHistory,
  deleteById,
}
