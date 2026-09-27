const db = require('../../lib/db')
const { getOwnedUserIds } = require('./admin.common.service')

function normalizeDays(value) {
  const days = Number(value)
  if (![7, 30, 90].includes(days)) throw Object.assign(new Error('统计周期仅支持 7、30 或 90 天'), { statusCode: 400 })
  return days
}

async function getSummary(rawDays, admin) {
  const days = normalizeDays(rawDays ?? 30)
  // 普通管理员只汇总自己负责的账号；匿名会话仅在同一会话已关联归属用户时纳入。
  const ownedUserIds = admin ? await getOwnedUserIds(admin) : null
  const { rows } = await db.query(
    `WITH selected_events AS (
       SELECT event_id,user_id,anonymous_id,session_id,event_name,occurred_at,properties
       FROM public.product_event
       WHERE occurred_at >= now() - ($1::int * interval '1 day')
         AND ($2::uuid[] IS NULL OR user_id = ANY($2::uuid[])
           OR (user_id IS NULL AND EXISTS (
             SELECT 1 FROM public.product_event linked
             WHERE linked.user_id = ANY($2::uuid[])
               AND linked.anonymous_id = product_event.anonymous_id
               AND linked.session_id = product_event.session_id
               AND linked.event_name IN ('signup_completed','login_completed')
           )))
     ),
     activations AS (
       SELECT user_id,MIN((occurred_at AT TIME ZONE 'Asia/Shanghai')::date) AS activation_day
       FROM selected_events
       WHERE user_id IS NOT NULL
         AND (event_name IN ('resume_saved','job_saved')
           OR (event_name='ai_task_finished' AND properties->>'result'='success'))
       GROUP BY user_id
     ),
     mature_cohort AS (
       SELECT user_id,activation_day FROM activations
       WHERE activation_day >= ((now() AT TIME ZONE 'Asia/Shanghai')::date - $1::int)
         AND activation_day <= ((now() AT TIME ZONE 'Asia/Shanghai')::date - 7)
     ),
     d7 AS (
       SELECT COUNT(*)::int AS cohort_size,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM public.product_event e
                WHERE e.user_id=c.user_id
                  AND (e.occurred_at AT TIME ZONE 'Asia/Shanghai')::date = c.activation_day + 7
                  AND e.event_name IN ('resume_saved','job_saved','job_stage_changed','workspace_action_opened','ai_task_finished')
              ))::int AS retained
       FROM mature_cohort c
     ),
     cta_sessions AS (
       SELECT DISTINCT anonymous_id,session_id FROM selected_events
       WHERE event_name='home_primary_cta_clicked' AND anonymous_id IS NOT NULL
     ),
     converted_sessions AS (
       SELECT DISTINCT c.anonymous_id,c.session_id
       FROM cta_sessions c
       JOIN selected_events s ON s.anonymous_id=c.anonymous_id AND s.session_id=c.session_id
       WHERE s.event_name='signup_completed'
     )
     SELECT
       (SELECT COUNT(*)::int FROM selected_events WHERE event_name='page_viewed') AS page_views,
       (SELECT COUNT(DISTINCT user_id)::int FROM selected_events WHERE user_id IS NOT NULL) AS active_users,
       (SELECT COUNT(*)::int FROM selected_events WHERE event_name='signup_completed') AS signups,
       (SELECT COUNT(DISTINCT user_id)::int FROM selected_events WHERE event_name='resume_saved') AS resume_savers,
       (SELECT COUNT(DISTINCT user_id)::int FROM selected_events WHERE event_name='job_saved') AS job_savers,
       (SELECT COUNT(DISTINCT user_id)::int FROM selected_events WHERE event_name='job_stage_changed') AS users_advancing_jobs,
       (SELECT COUNT(*)::int FROM selected_events WHERE event_name='recharge_flow_step' AND properties->>'step'='submitted') AS recharge_submissions,
       (SELECT COUNT(*)::int FROM selected_events WHERE event_name='recharge_flow_step' AND properties->>'step'='credited') AS recharge_credits,
       (SELECT COUNT(*)::int FROM cta_sessions) AS cta_sessions,
       (SELECT COUNT(*)::int FROM converted_sessions) AS converted_sessions,
       d7.cohort_size,d7.retained
     FROM d7`,
    [days, ownedUserIds],
  )
  const row = rows[0] || {}
  const cohortSize = Number(row.cohort_size || 0)
  const retained = Number(row.retained || 0)
  const ctaSessions = Number(row.cta_sessions || 0)
  return {
    days,
    page_views: Number(row.page_views || 0),
    active_users: Number(row.active_users || 0),
    signups: Number(row.signups || 0),
    resume_savers: Number(row.resume_savers || 0),
    job_savers: Number(row.job_savers || 0),
    users_advancing_jobs: Number(row.users_advancing_jobs || 0),
    recharge_submissions: Number(row.recharge_submissions || 0),
    recharge_credits: Number(row.recharge_credits || 0),
    cta_sessions: ctaSessions,
    converted_sessions: Number(row.converted_sessions || 0),
    cta_to_signup_rate: ctaSessions ? Number(row.converted_sessions || 0) / ctaSessions : null,
    d7_cohort_size: cohortSize,
    d7_retained: retained,
    d7_retention_rate: cohortSize ? retained / cohortSize : null,
  }
}

module.exports = { getSummary, normalizeDays }
