/**
 * 浏览器 Agent 收藏岗位仓库。
 * 只负责用户隔离的数据读取与写入，不承载 AI 或 HTTP 语义。
 */
const db = require('../lib/db')

const DETAIL_FIELDS = `
  id, source_url, source_platform, source_original, title, company, location, address,
  salary, skills, jd_text, resume_id, match_result, status, create_time, update_time
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

module.exports = {
  findById,
  findLatestResumeId,
  updateAnalysis,
  deleteById,
}
