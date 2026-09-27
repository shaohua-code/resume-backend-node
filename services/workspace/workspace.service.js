/** 登录工作台聚合：只返回当前用户的摘要和可继续动作，不读取简历正文。 */
const db = require('../../lib/db')

async function getSummary(userId) {
  const { rows } = await db.query(
    `WITH activities AS (
       SELECT 'resume'::text AS resource_type,id,COALESCE(title,'未命名简历') AS display_title,
              NULL::text AS detail,(update_time AT TIME ZONE 'UTC') AS occurred_at
       FROM public.resume WHERE user_id=$1
       UNION ALL
       SELECT 'job'::text AS resource_type,id,COALESCE(title,'未命名岗位') AS display_title,
              COALESCE(company,'') AS detail,(update_time AT TIME ZONE 'UTC') AS occurred_at
       FROM public.extension_saved_job WHERE user_id=$1
     )
     SELECT
       (SELECT COUNT(*)::int FROM public.resume WHERE user_id=$1) AS resume_count,
       (SELECT COUNT(*)::int FROM public.career_goal WHERE user_id=$1 AND status='active') AS active_goal_count,
       (SELECT COUNT(*)::int FROM public.extension_saved_job WHERE user_id=$1 AND application_stage <> 'archived') AS job_count,
       (SELECT COUNT(*)::int FROM public.extension_saved_job
          WHERE user_id=$1 AND application_stage IN ('preparing','applied','interviewing')) AS in_progress_job_count,
       (SELECT COUNT(*)::int FROM public.extension_saved_job
          WHERE user_id=$1 AND next_action_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
            AND application_stage NOT IN ('archived','offer','rejected','withdrawn')) AS due_action_count,
       (SELECT jsonb_build_object('id',id,'name',name,'job_direction',job_direction,'target_city',target_city)
          FROM public.career_goal WHERE user_id=$1 AND status='active'
          ORDER BY is_primary DESC, update_time DESC LIMIT 1) AS primary_goal,
       (SELECT jsonb_build_object('id',id,'title',COALESCE(title,'未命名简历'),'update_time',update_time)
          FROM public.resume WHERE user_id=$1 ORDER BY update_time DESC,id DESC LIMIT 1) AS recent_resume,
       (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.occurred_at DESC), '[]'::jsonb)
          FROM (SELECT * FROM activities ORDER BY occurred_at DESC LIMIT 5) a) AS recent_activity,
       (SELECT jsonb_build_object('id',id,'title',title,'company',company,'application_stage',application_stage,'next_action_at',next_action_at)
          FROM public.extension_saved_job WHERE user_id=$1 AND application_stage IN ('saved','preparing','applied','interviewing')
          ORDER BY (next_action_at IS NULL), next_action_at, update_time DESC LIMIT 1) AS next_job`,
    [userId],
  )
  const row = rows[0] || {}
  let nextAction
  if (Number(row.due_action_count) > 0 && row.next_job) {
    nextAction = { type: 'update_job', label: '更新求职下一步', job_id: row.next_job.id, due_at: row.next_job.next_action_at, path: '/user?tab=saved-jobs' }
  } else if (!Number(row.resume_count)) {
    nextAction = { type: 'create_resume', label: '创建第一份简历', path: '/generate' }
  } else if (!Number(row.active_goal_count)) {
    nextAction = { type: 'create_goal', label: '设定求职目标', path: '/user?tab=career-goals' }
  } else if (row.next_job) {
    nextAction = { type: 'review_job', label: '继续跟进岗位', job_id: row.next_job.id, path: '/user?tab=saved-jobs' }
  } else {
    nextAction = { type: 'continue_resume', label: '继续完善最近的简历', resume_id: row.recent_resume?.id, path: row.recent_resume ? `/editor/${row.recent_resume.id}` : '/generate' }
  }
  return {
    resume_count: Number(row.resume_count || 0),
    active_goal_count: Number(row.active_goal_count || 0),
    job_count: Number(row.job_count || 0),
    in_progress_job_count: Number(row.in_progress_job_count || 0),
    due_action_count: Number(row.due_action_count || 0),
    primary_goal: row.primary_goal || null,
    recent_resume: row.recent_resume || null,
    recent_activity: Array.isArray(row.recent_activity) ? row.recent_activity : [],
    next_job: row.next_job || null,
    next_action: nextAction,
  }
}

const ONBOARDING_STEPS = new Set(['goal', 'resume', 'job'])

async function getOnboarding(userId) {
  const { rows } = await db.query(
    'SELECT version,completed_steps,dismissed,update_time FROM public.user_onboarding_state WHERE user_id=$1 LIMIT 1',
    [userId],
  )
  return rows[0] || { version: 1, completed_steps: [], dismissed: false }
}

async function updateOnboarding(userId, input = {}) {
  if (input.version !== undefined && Number(input.version) !== 1) {
    throw Object.assign(new Error('引导版本无效，请刷新页面后重试'), { statusCode: 400 })
  }
  if (input.completed_steps !== undefined && (!Array.isArray(input.completed_steps)
      || input.completed_steps.length > ONBOARDING_STEPS.size
      || input.completed_steps.some((step) => !ONBOARDING_STEPS.has(step)))) {
    throw Object.assign(new Error('引导步骤无效'), { statusCode: 400 })
  }
  if (input.dismissed !== undefined && typeof input.dismissed !== 'boolean') {
    throw Object.assign(new Error('引导状态无效'), { statusCode: 400 })
  }
  const { rows } = await db.query(
    `INSERT INTO public.user_onboarding_state (user_id,version,completed_steps,dismissed,update_time)
     VALUES ($1,1,COALESCE($2::text[],ARRAY[]::text[]),COALESCE($3::boolean,false),now())
     ON CONFLICT (user_id) DO UPDATE SET
       completed_steps=COALESCE($2::text[],public.user_onboarding_state.completed_steps),
       dismissed=COALESCE($3::boolean,public.user_onboarding_state.dismissed),
       update_time=now()
     RETURNING version,completed_steps,dismissed,update_time`,
    [userId, input.completed_steps ?? null, input.dismissed ?? null],
  )
  return rows[0]
}

module.exports = { getSummary, getOnboarding, updateOnboarding }
