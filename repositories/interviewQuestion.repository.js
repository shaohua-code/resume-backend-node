/** 面试题仓库集中处理用户归属、幂等键与题目练习的事务写入。 */
const db = require('../lib/db')

const SET_SELECT = `
  s.id, s.user_id, s.resume_id, s.career_goal_id, s.saved_job_id,
  s.target_position, s.jd_snapshot, s.resume_snapshot, s.question_count,
  s.generation_status, s.ai_call_id, s.create_time, s.update_time,
  COUNT(q.id)::int AS question_count_actual,
  COUNT(p.id) FILTER (WHERE p.status <> 'todo')::int AS practiced_count,
  COUNT(p.id) FILTER (WHERE p.status = 'mastered')::int AS mastered_count,
  CASE WHEN COUNT(q.id) > 0 AND COUNT(p.id) FILTER (WHERE p.status = 'mastered') = COUNT(q.id)
       THEN 'mastered'
       WHEN COUNT(p.id) FILTER (WHERE p.status <> 'todo') > 0 THEN 'practicing'
       ELSE 'todo' END AS practice_status`

// 列表只返回筛选/摘要需要的列，避免把简历与 JD 快照随分页暴露。
const LIST_SET_SELECT = `
  s.id, s.user_id, s.resume_id, s.target_position, s.question_count,
  s.generation_status, s.create_time, s.update_time,
  COUNT(q.id)::int AS question_count_actual,
  COUNT(p.id) FILTER (WHERE p.status <> 'todo')::int AS practiced_count,
  COUNT(p.id) FILTER (WHERE p.status = 'mastered')::int AS mastered_count,
  CASE WHEN COUNT(q.id) > 0 AND COUNT(p.id) FILTER (WHERE p.status = 'mastered') = COUNT(q.id)
       THEN 'mastered'
       WHEN COUNT(p.id) FILTER (WHERE p.status <> 'todo') > 0 THEN 'practicing'
       ELSE 'todo' END AS practice_status`

async function findByRequestKey(userId, requestKey) {
  const { rows } = await db.query(
    `SELECT ${SET_SELECT}
     FROM public.interview_question_set s
     LEFT JOIN public.interview_question q ON q.set_id=s.id AND q.user_id=s.user_id
     LEFT JOIN public.interview_practice p ON p.question_id=q.id AND p.set_id=s.id AND p.user_id=s.user_id
     WHERE s.user_id=$1 AND s.request_key=$2
     GROUP BY s.id LIMIT 1`,
    [userId, requestKey],
  )
  return rows[0] || null
}

// 先登记 generating 状态，再调用模型；重试沿用 request_key，已完成请求直接返回。
async function reserveSet(userId, context, requestKey) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`interview-set:${userId}:${requestKey}`])
    const { rows: existing } = await client.query(
      `SELECT id, generation_status FROM public.interview_question_set
       WHERE user_id=$1 AND request_key=$2 FOR UPDATE`,
      [userId, requestKey],
    )
    if (existing.length && existing[0].generation_status === 'completed') {
      await client.query('COMMIT')
      return { id: existing[0].id, completed: true }
    }
    if (existing.length && existing[0].generation_status === 'generating') {
      await client.query('COMMIT')
      return { id: existing[0].id, busy: true }
    }
    if (existing.length) {
      await client.query(
        `UPDATE public.interview_question_set SET generation_status='generating', update_time=now()
         WHERE id=$1 AND user_id=$2`,
        [existing[0].id, userId],
      )
      await client.query('COMMIT')
      return { id: existing[0].id, completed: false }
    }
    const { rows } = await client.query(
      `INSERT INTO public.interview_question_set
       (user_id,resume_id,career_goal_id,saved_job_id,target_position,jd_snapshot,resume_snapshot,request_key,generation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'generating') RETURNING id`,
      [userId, context.resumeId, context.careerGoalId, context.savedJobId, context.targetPosition,
        context.jdText, JSON.stringify(context.resumeSnapshot), requestKey],
    )
    await client.query('COMMIT')
    return { id: rows[0].id, completed: false }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// 完整题目集与待练习记录同一事务落库，避免展示半套题目。
async function completeSet(userId, setId, questions, { deferCompletion = false } = {}) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows: sets } = await client.query(
      `SELECT id FROM public.interview_question_set
       WHERE id=$1 AND user_id=$2 AND generation_status='generating' FOR UPDATE`,
      [setId, userId],
    )
    if (!sets.length) throw Object.assign(new Error('面试题生成任务已失效，请重新发起'), { statusCode: 409 })
    for (const [index, question] of questions.entries()) {
    const { rows } = await client.query(
      `INSERT INTO public.interview_question
       (set_id,user_id,category,question,evaluation_focus,resume_evidence,answer_guidance,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (set_id,user_id,sort_order) DO UPDATE SET
         category=EXCLUDED.category,question=EXCLUDED.question,
         evaluation_focus=EXCLUDED.evaluation_focus,resume_evidence=EXCLUDED.resume_evidence,
         answer_guidance=EXCLUDED.answer_guidance
       RETURNING id`,
        [setId, userId, question.category, question.question, question.evaluation_focus,
          question.resume_evidence, question.answer_guidance, index],
      )
      await client.query(
        `INSERT INTO public.interview_practice (question_id,set_id,user_id,status)
         VALUES ($1,$2,$3,'todo') ON CONFLICT (question_id,user_id) DO NOTHING`,
        [rows[0].id, setId, userId],
      )
    }
    await client.query(
      `DELETE FROM public.interview_question WHERE set_id=$1 AND user_id=$2 AND sort_order >= $3`,
      [setId, userId, questions.length],
    )
    // 异步模式等待 AI 调用审计与费用记录完成后，才向题库发布整套题目。
    await client.query(
      `UPDATE public.interview_question_set SET question_count=$3,
       generation_status=CASE WHEN $4 THEN 'generating' ELSE 'completed' END,update_time=now()
       WHERE id=$1 AND user_id=$2`,
      [setId, userId, questions.length, deferCompletion],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// 调用记录、扣费关联完成后，在同一事务发布整套题并释放活动任务唯一约束。
async function finishGenerationJob(jobId, userId, setId, questionCount, aiCallId) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows: sets } = await client.query(
      `UPDATE public.interview_question_set SET generation_status='completed',question_count=$3,
       ai_call_id=$4,update_time=now()
       WHERE id=$1 AND user_id=$2 AND generation_status='generating' RETURNING id`,
      [setId, userId, questionCount, aiCallId || null],
    )
    if (!sets.length) throw Object.assign(new Error('题目生成任务状态已变化，请刷新题库'), { statusCode: 409 })
    await client.query(
      `UPDATE public.interview_question_generation_job SET status='completed',stage='completed',
       status_message='题目已保存，可以开始练习',generated_count=$4,ai_call_id=$5,
       request_payload='{}'::jsonb,heartbeat_at=now(),completed_at=now(),update_time=now()
       WHERE id=$1 AND user_id=$2 AND set_id=$3 AND status='running'`,
      [jobId, userId, setId, questionCount, aiCallId || null],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function markSetFailed(userId, setId) {
  await db.query(
    `UPDATE public.interview_question_set SET generation_status='failed', update_time=now()
     WHERE id=$1 AND user_id=$2 AND generation_status='generating'`,
    [setId, userId],
  )
}

async function findGenerationJobByRequestKey(userId, requestKey) {
  const { rows } = await db.query(
    `SELECT id,set_id,status,stage,generated_count,total_count,request_key
     FROM public.interview_question_generation_job WHERE user_id=$1 AND request_key=$2 LIMIT 1`,
    [userId, requestKey],
  )
  return rows[0] || null
}

// 在用户级事务锁下创建套题和排队任务，避免不同页面、标签页同时启动两次模型调用。
async function createGenerationJob(userId, context, requestKey, options = {}) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`interview-generation:${userId}`])
    const { rows: sameJobs } = await client.query(
      `SELECT id,set_id,status,stage,generated_count,total_count,request_key
       FROM public.interview_question_generation_job WHERE user_id=$1 AND request_key=$2 FOR UPDATE`,
      [userId, requestKey],
    )
    if (sameJobs.length) {
      await client.query('COMMIT')
      return { job: sameJobs[0], reused: true }
    }
    const { rows: activeJobs } = await client.query(
      `SELECT id,set_id FROM public.interview_question_generation_job
       WHERE user_id=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [userId],
    )
    if (activeJobs.length) {
      await client.query('COMMIT')
      return { busy: true, activeJobId: activeJobs[0].id }
    }
    // 旧版同步 SSE 部署过渡时可能留下 generating 套题；给正在执行的旧请求留出 3 分钟窗口。
    const { rows: legacySets } = await client.query(
      `SELECT s.id,s.update_time FROM public.interview_question_set s
       WHERE s.user_id=$1 AND s.generation_status='generating'
         AND NOT EXISTS (SELECT 1 FROM public.interview_question_generation_job j WHERE j.set_id=s.id)
       ORDER BY s.update_time DESC LIMIT 1 FOR UPDATE`,
      [userId],
    )
    if (legacySets.length && Date.now() - new Date(legacySets[0].update_time).getTime() < 180000) {
      await client.query('COMMIT')
      return { busy: true, legacySetId: legacySets[0].id }
    }
    if (legacySets.length) {
      await client.query(
        `UPDATE public.interview_question_set SET generation_status='failed',update_time=now()
         WHERE id=$1 AND user_id=$2 AND generation_status='generating'`,
        [legacySets[0].id, userId],
      )
    }
    const { rows: previousSets } = await client.query(
      `SELECT id,generation_status FROM public.interview_question_set
       WHERE user_id=$1 AND request_key=$2 FOR UPDATE`,
      [userId, requestKey],
    )
    if (previousSets.length) {
      await client.query('COMMIT')
      return { conflict: true, setId: previousSets[0].id }
    }
    const { rows: setRows } = await client.query(
      `INSERT INTO public.interview_question_set
       (user_id,resume_id,career_goal_id,saved_job_id,target_position,jd_snapshot,resume_snapshot,
        question_count,request_key,generation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'generating') RETURNING id`,
      [userId, context.resumeId, context.careerGoalId, context.savedJobId, context.targetPosition,
        context.jdText, JSON.stringify(context.resumeSnapshot), context.questionCount, requestKey],
    )
    const payload = {
      resumeId: context.resumeId,
      careerGoalId: context.careerGoalId,
      savedJobId: context.savedJobId,
      targetPosition: context.targetPosition,
      jdText: context.jdText,
      categories: context.categories,
      questionCount: context.questionCount,
      resumeJson: context.resumeJson,
      resumeSnapshot: context.resumeSnapshot,
      avoidHistory: Boolean(options.avoidHistory),
    }
    const { rows: jobRows } = await client.query(
      `INSERT INTO public.interview_question_generation_job
       (user_id,set_id,request_key,status,stage,status_message,total_count,request_payload,heartbeat_at)
       VALUES ($1,$2,$3,'queued','preparing','已加入后台生成队列', $4, $5::jsonb, now())
       RETURNING id,set_id,status,stage,generated_count,total_count,request_key`,
      [userId, setRows[0].id, requestKey, context.questionCount, JSON.stringify(payload)],
    )
    await client.query('COMMIT')
    return { job: jobRows[0], created: true }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// 领取队列采用 SKIP LOCKED，多实例可并行消费不同任务，但不会重复认领同一任务。
async function claimNextGenerationJob() {
  const { rows } = await db.query(
    `WITH next_job AS (
       SELECT id FROM public.interview_question_generation_job
       WHERE status='queued' ORDER BY create_time,id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE public.interview_question_generation_job j
     SET status='running',stage='preparing',status_message='正在准备简历和岗位信息',
         attempt_started_at=now(),heartbeat_at=now(),update_time=now()
     FROM next_job n, public.user_profile p
     WHERE j.id=n.id AND p.user_id=j.user_id
     RETURNING j.*,p.role AS user_role`,
  )
  return rows[0] || null
}

// 用户进度只返回业务阶段、计数和已验证题目，不包含内部 payload、简历快照或回答。
async function findGenerationJob(userId, jobId) {
  const { rows } = await db.query(
    `SELECT j.id,j.user_id,j.set_id,j.status,j.stage,j.status_message,j.generated_count,
            j.total_count,j.error_message,j.create_time,j.update_time,j.completed_at,
            s.resume_id,s.target_position,s.generation_status
     FROM public.interview_question_generation_job j
     JOIN public.interview_question_set s ON s.id=j.set_id AND s.user_id=j.user_id
     WHERE j.id=$1 AND j.user_id=$2 LIMIT 1`,
    [jobId, userId],
  )
  if (!rows.length) return null
  const job = rows[0]
  const { rows: questions } = await db.query(
    `SELECT id,category,question,evaluation_focus,resume_evidence,answer_guidance,sort_order
     FROM public.interview_question WHERE set_id=$1 AND user_id=$2 ORDER BY sort_order,id`,
    [job.set_id, userId],
  )
  return { ...job, questions }
}

async function findActiveGenerationJob(userId) {
  const { rows } = await db.query(
    `SELECT id FROM public.interview_question_generation_job
     WHERE user_id=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ? findGenerationJob(userId, rows[0].id) : null
}

async function listGenerationJobs(userId, limit = 10) {
  const { rows } = await db.query(
    `SELECT j.id,j.set_id,j.status,j.stage,j.status_message,j.generated_count,j.total_count,j.error_message,
            j.create_time,j.update_time,j.completed_at,s.target_position
     FROM public.interview_question_generation_job j
     JOIN public.interview_question_set s ON s.id=j.set_id AND s.user_id=j.user_id
     WHERE j.user_id=$1
     ORDER BY j.create_time DESC,j.id DESC LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 10, 1), 20)],
  )
  return rows
}

async function updateGenerationStage(jobId, userId, stage, message) {
  await db.query(
    `UPDATE public.interview_question_generation_job SET stage=$3,status_message=$4,
       heartbeat_at=now(),update_time=now() WHERE id=$1 AND user_id=$2 AND status='running'`,
    [jobId, userId, stage, message],
  )
}

async function heartbeatGenerationJob(jobId, userId) {
  await db.query(
    `UPDATE public.interview_question_generation_job SET heartbeat_at=now(),update_time=now()
     WHERE id=$1 AND user_id=$2 AND status='running'`,
    [jobId, userId],
  )
}

// 每道校验通过的题与练习初始态原子落库，因此任务查询可跨刷新恢复已完成部分。
async function appendQuestionProgress(jobId, userId, setId, question, index) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO public.interview_question
       (set_id,user_id,category,question,evaluation_focus,resume_evidence,answer_guidance,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (set_id,user_id,sort_order) DO UPDATE SET
         category=EXCLUDED.category,question=EXCLUDED.question,evaluation_focus=EXCLUDED.evaluation_focus,
         resume_evidence=EXCLUDED.resume_evidence,answer_guidance=EXCLUDED.answer_guidance
       RETURNING id`,
      [setId, userId, question.category, question.question, question.evaluation_focus,
        question.resume_evidence, question.answer_guidance, index],
    )
    await client.query(
      `INSERT INTO public.interview_practice (question_id,set_id,user_id,status)
       VALUES ($1,$2,$3,'todo') ON CONFLICT (question_id,user_id) DO NOTHING`,
      [rows[0].id, setId, userId],
    )
    await client.query(
      `UPDATE public.interview_question_generation_job SET generated_count=GREATEST(generated_count,$3),
         stage='generating',status_message=$4,heartbeat_at=now(),update_time=now()
       WHERE id=$1 AND user_id=$2 AND status='running'`,
      [jobId, userId, index + 1, `已生成第 ${index + 1} 道题，模型正在整理后续问题`],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function linkGenerationJobCall(jobId, userId, aiCallId) {
  await db.query(
    `UPDATE public.interview_question_generation_job SET ai_call_id=$3,update_time=now()
     WHERE id=$1 AND user_id=$2`,
    [jobId, userId, aiCallId],
  )
}

// 失败结果使用脱敏中文原因并保留已经生成的题目，不由 worker 自动重放模型调用。
async function failGenerationJob(jobId, userId, setId, errorMessage) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE public.interview_question_generation_job SET status='failed',stage='failed',
       status_message='本次生成未完成',error_message=$3,request_payload='{}'::jsonb,
       heartbeat_at=now(),completed_at=now(),update_time=now()
       WHERE id=$1 AND user_id=$2 AND status='running'`,
      [jobId, userId, errorMessage],
    )
    await client.query(
      `UPDATE public.interview_question_set SET generation_status='failed',update_time=now()
       WHERE id=$1 AND user_id=$2 AND generation_status='generating'`,
      [setId, userId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// 心跳过期任务明确标记失败，避免服务重启后重复调用并产生不可见的二次费用。
async function failStaleGenerationJobs(staleSeconds = 360) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE public.interview_question_generation_job SET status='failed',stage='failed',
       status_message='后台服务中断，任务已停止，可查看已生成题目后重新发起',
       error_message='任务等待后台处理超时，请检查已生成题目后重新发起。',
       request_payload='{}'::jsonb,completed_at=now(),update_time=now()
       WHERE status='running' AND heartbeat_at < now() - ($1::int * interval '1 second')
       RETURNING id,user_id,set_id`,
      [staleSeconds],
    )
    for (const job of rows) {
      await client.query(
        `UPDATE public.interview_question_set SET generation_status='failed',update_time=now()
         WHERE id=$1 AND user_id=$2 AND generation_status='generating'`,
        [job.set_id, job.user_id],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// AI 点评上下文仅由套题、题目与当前账号联合读取，不接受前端提交简历证据。
async function findQuestionReviewContext(userId, setId, questionId) {
  const { rows } = await db.query(
    `SELECT s.id AS set_id,s.user_id,s.target_position,s.jd_snapshot,s.resume_snapshot,
            q.id AS question_id,q.question,q.evaluation_focus,q.resume_evidence,
            p.answer_draft,p.status AS practice_status
     FROM public.interview_question_set s
     JOIN public.interview_question q ON q.set_id=s.id AND q.user_id=s.user_id
     JOIN public.interview_practice p ON p.question_id=q.id AND p.set_id=q.set_id AND p.user_id=q.user_id
     WHERE s.id=$1 AND s.user_id=$2 AND s.generation_status='completed' AND q.id=$3 LIMIT 1`,
    [setId, userId, questionId],
  )
  return rows[0] || null
}

// 每次 AI 点评都保存提交时回答快照，并把该答案先存入个人练习记录，失败后也可继续编辑。
async function reserveAnswerReview(userId, setId, questionId, answer) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`interview-answer-review:${userId}:${questionId}`])
    const { rows: owned } = await client.query(
      `SELECT q.id FROM public.interview_question q
       JOIN public.interview_question_set s ON s.id=q.set_id AND s.user_id=q.user_id
       WHERE q.id=$1 AND q.set_id=$2 AND q.user_id=$3 AND s.generation_status='completed' FOR UPDATE`,
      [questionId, setId, userId],
    )
    if (!owned.length) {
      await client.query('COMMIT')
      return null
    }
    await client.query(
      `UPDATE public.interview_practice SET answer_draft=$4,status='practiced',
       last_practiced_at=now(),update_time=now()
       WHERE question_id=$1 AND set_id=$2 AND user_id=$3`,
      [questionId, setId, userId, answer],
    )
    const { rows: versions } = await client.query(
      `SELECT COALESCE(MAX(review_version),0)+1 AS version FROM public.interview_answer_review
       WHERE question_id=$1 AND user_id=$2`,
      [questionId, userId],
    )
    const { rows } = await client.query(
      `INSERT INTO public.interview_answer_review
       (user_id,set_id,question_id,review_version,answer_snapshot,review_status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [userId, setId, questionId, versions[0].version, answer],
    )
    await client.query('COMMIT')
    return rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function completeAnswerReview(userId, reviewId, result) {
  const { rows } = await db.query(
    `UPDATE public.interview_answer_review SET review_status='completed',review_result=$3::jsonb,
       error_message=NULL,update_time=now()
     WHERE id=$1 AND user_id=$2 AND review_status='pending' RETURNING *`,
    [reviewId, userId, JSON.stringify(result)],
  )
  return rows[0] || null
}

async function failAnswerReview(userId, reviewId, errorMessage) {
  await db.query(
    `UPDATE public.interview_answer_review SET review_status='failed',error_message=$3,update_time=now()
     WHERE id=$1 AND user_id=$2 AND review_status='pending'`,
    [reviewId, userId, errorMessage],
  )
}

async function linkAnswerReviewCall(userId, reviewId, aiCallId) {
  if (!aiCallId) return
  await db.query(
    'UPDATE public.interview_answer_review SET ai_call_id=$3,update_time=now() WHERE id=$1 AND user_id=$2',
    [reviewId, userId, aiCallId],
  )
}

// 点评历史只按本人、套题和题目三重归属返回，管理员题库接口不会调用此方法。
async function listAnswerReviews(userId, setId, questionId) {
  const { rows } = await db.query(
    `SELECT id,user_id,set_id,question_id,review_version,answer_snapshot,review_result,
            review_status,error_message,ai_call_id,create_time,update_time
     FROM public.interview_answer_review
     WHERE user_id=$1 AND set_id=$2 AND question_id=$3
     ORDER BY review_version DESC`,
    [userId, setId, questionId],
  )
  return rows
}

async function linkAiCall(userId, setId, aiCallId) {
  if (!aiCallId) return
  await db.query(
    'UPDATE public.interview_question_set SET ai_call_id=$3 WHERE id=$1 AND user_id=$2',
    [setId, userId, aiCallId],
  )
}

function addFilter(clauses, values, expression, value) {
  values.push(value)
  clauses.push(expression.replace('?', `$${values.length}`))
}

async function listSets({ userId, userIds, page = 1, size = 10, keyword = '', resumeId = '', status = '', dateFrom = '', dateTo = '' }) {
  const values = []
  const clauses = ["s.generation_status='completed'"]
  if (userId) addFilter(clauses, values, 's.user_id=?', userId)
  if (userIds !== null && userIds !== undefined) {
    if (!userIds.length) clauses.push('FALSE')
    else addFilter(clauses, values, `s.user_id = ANY(?::uuid[])`, userIds)
  }
  if (keyword) addFilter(clauses, values, `s.target_position ILIKE ?`, `%${keyword}%`)
  if (resumeId) addFilter(clauses, values, 's.resume_id=?', Number(resumeId))
  if (dateFrom) addFilter(clauses, values, 's.create_time>=?', dateFrom)
  if (dateTo) addFilter(clauses, values, 's.create_time<?', dateTo)
  if (status === 'todo') clauses.push("COALESCE(pr.practice_status,'todo')='todo'")
  if (status === 'practicing') clauses.push("COALESCE(pr.practice_status,'todo')='practicing'")
  if (status === 'mastered') clauses.push("COALESCE(pr.practice_status,'todo')='mastered'")
  const where = clauses.join(' AND ')
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM public.interview_question_set s
     LEFT JOIN LATERAL (
       SELECT CASE WHEN COUNT(q.id)>0 AND COUNT(p.id) FILTER (WHERE p.status='mastered')=COUNT(q.id) THEN 'mastered'
         WHEN COUNT(p.id) FILTER (WHERE p.status<>'todo')>0 THEN 'practicing' ELSE 'todo' END AS practice_status
       FROM public.interview_question q LEFT JOIN public.interview_practice p
         ON p.question_id=q.id AND p.set_id=q.set_id AND p.user_id=q.user_id
       WHERE q.set_id=s.id AND q.user_id=s.user_id
     ) pr ON true WHERE ${where}`,
    values,
  )
  const limitIndex = values.length + 1
  const offsetIndex = values.length + 2
  const { rows } = await db.query(
    `SELECT ${LIST_SET_SELECT}, u.nickname, u.email
     FROM public.interview_question_set s
     LEFT JOIN public.user_profile u ON u.user_id=s.user_id
     LEFT JOIN LATERAL (
       SELECT CASE WHEN COUNT(qs.id)>0 AND COUNT(ps.id) FILTER (WHERE ps.status='mastered')=COUNT(qs.id) THEN 'mastered'
         WHEN COUNT(ps.id) FILTER (WHERE ps.status<>'todo')>0 THEN 'practicing' ELSE 'todo' END AS practice_status
       FROM public.interview_question qs LEFT JOIN public.interview_practice ps
         ON ps.question_id=qs.id AND ps.set_id=qs.set_id AND ps.user_id=qs.user_id
       WHERE qs.set_id=s.id AND qs.user_id=s.user_id
     ) pr ON true
     LEFT JOIN public.interview_question q ON q.set_id=s.id AND q.user_id=s.user_id
     LEFT JOIN public.interview_practice p ON p.question_id=q.id AND p.set_id=s.id AND p.user_id=s.user_id
     WHERE ${where} GROUP BY s.id,u.nickname,u.email
     ORDER BY s.create_time DESC,s.id DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    [...values, size, (page - 1) * size],
  )
  return { items: rows, total: countResult.rows[0]?.total || 0 }
}

async function findSet(userId, setId, { admin = false } = {}) {
  const values = [setId]
  const ownerClause = userId ? 'AND s.user_id=$2' : ''
  // 管理端详情只读取题目所需上下文，不返回保存的 JD/简历快照。
  const setColumns = admin
    ? 's.id,s.user_id,s.resume_id,s.target_position,s.question_count,s.generation_status,s.ai_call_id,s.create_time,s.update_time'
    : 's.*'
  if (userId) values.push(userId)
  const { rows } = await db.query(
    `SELECT ${setColumns},u.nickname,u.email FROM public.interview_question_set s
     LEFT JOIN public.user_profile u ON u.user_id=s.user_id
     WHERE s.id=$1 ${ownerClause} AND s.generation_status='completed' LIMIT 1`,
    values,
  )
  const set = rows[0]
  if (!set) return null
  const practiceFields = admin
    ? 'p.status,p.last_practiced_at,p.update_time AS practice_update_time'
    : 'p.status,p.answer_draft,p.reflection,p.last_practiced_at,p.update_time AS practice_update_time'
  const { rows: questions } = await db.query(
    `SELECT q.id,q.category,q.question,q.evaluation_focus,q.resume_evidence,q.answer_guidance,q.sort_order,${practiceFields}
     FROM public.interview_question q
     JOIN public.interview_practice p ON p.question_id=q.id AND p.set_id=q.set_id AND p.user_id=q.user_id
     WHERE q.set_id=$1 AND q.user_id=$2 ORDER BY q.sort_order,q.id`,
    [setId, set.user_id],
  )
  return { ...set, questions }
}

async function updatePractice(userId, setId, questionId, practice) {
  const { rows } = await db.query(
    `UPDATE public.interview_practice p SET
       status=$4,answer_draft=$5,reflection=$6,
       last_practiced_at=CASE WHEN $4='todo' THEN NULL ELSE now() END,update_time=now()
     FROM public.interview_question q
     WHERE p.question_id=q.id AND p.set_id=q.set_id AND p.user_id=q.user_id
       AND p.user_id=$1 AND p.set_id=$2 AND p.question_id=$3
     RETURNING p.id,p.status,p.answer_draft,p.reflection,p.last_practiced_at,p.update_time`,
    [userId, setId, questionId, practice.status, practice.answerDraft, practice.reflection],
  )
  return rows[0] || null
}

async function deleteSet(userId, setId) {
  const { rows } = await db.query(
    'DELETE FROM public.interview_question_set WHERE id=$1 AND user_id=$2 AND generation_status<>\'generating\' RETURNING id',
    [setId, userId],
  )
  return rows[0] || null
}

async function listRecentQuestions(userId, limit = 120) {
  const { rows } = await db.query(
    `SELECT q.question FROM public.interview_question q
     JOIN public.interview_question_set s ON s.id=q.set_id AND s.user_id=q.user_id
     WHERE q.user_id=$1 AND s.generation_status='completed'
     ORDER BY s.create_time DESC,q.sort_order LIMIT $2`,
    [userId, limit],
  )
  return rows.map((row) => row.question)
}

module.exports = {
  findByRequestKey, reserveSet, completeSet, finishGenerationJob, markSetFailed, linkAiCall,
  createGenerationJob, findGenerationJobByRequestKey, claimNextGenerationJob, findGenerationJob, findActiveGenerationJob,
  listGenerationJobs, updateGenerationStage, heartbeatGenerationJob, appendQuestionProgress,
  linkGenerationJobCall, failGenerationJob, failStaleGenerationJobs,
  findQuestionReviewContext, reserveAnswerReview, completeAnswerReview, failAnswerReview,
  linkAnswerReviewCall, listAnswerReviews, listSets, findSet, updatePractice, deleteSet, listRecentQuestions,
}
