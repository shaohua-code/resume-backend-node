/**
 * 产品行为事件的白名单与持久化；事件写入只用于分析，不能参与用户业务事务。
 */
const { randomUUID } = require('node:crypto')
const db = require('../../lib/db')

const EVENT_RULES = Object.freeze({
  page_viewed: { page: ['home', 'login', 'register', 'forgot_password', 'templates', 'generate', 'editor', 'user', 'extension', 'extension_connect', 'admin', 'not_found'] },
  login_completed: { login_method: ['password', 'email_code'] },
  home_primary_cta_clicked: { visitor_state: ['anonymous', 'logged_in'], cta_id: ['start_resume', 'continue_work', 'browse_templates', 'view_extension'] },
  signup_completed: { signup_method: ['random', 'email', 'password'], source_channel: ['direct', 'wechat', 'xiaohongshu', 'douyin', 'other'] },
  onboarding_step_completed: { step_id: ['goal', 'resume', 'job'], duration_bucket: ['under_1m', '1_5m', 'over_5m'] },
  resume_saved: { is_first: ['true', 'false'], source_type: ['manual', 'upload', 'ai', 'copy'] },
  ai_task_finished: { task_type: ['generate', 'optimize', 'jd_optimize', 'match', 'score', 'extract'], result: ['success', 'failed'], cost_bucket: ['zero', 'under_1', '1_10', 'over_10', 'unknown'] },
  career_goal_created: { is_primary: ['true', 'false'] },
  job_saved: { source_platform: ['boss', 'liepin', 'zhilian', '51job', 'other'], goal_linked: ['true', 'false'] },
  job_stage_changed: { from_stage: ['saved', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived'], to_stage: ['saved', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived'], has_next_action_date: ['true', 'false'] },
  workspace_action_opened: { action_type: ['create_resume', 'continue_resume', 'create_goal', 'review_job', 'update_job'], source_surface: ['home', 'workspace', 'saved_jobs'] },
  email_bound: { entry_point: ['profile', 'ai_gate', 'signup', 'recovery'] },
  recharge_flow_step: { step: ['opened', 'submitted', 'credited'], amount_bucket: ['under_10', '10_50', '50_200', 'over_200', 'unknown'], result: ['success', 'pending', 'failed'] },
  workspace_returned: { days_since_last_active_bucket: ['1', '2_7', '8_30', 'over_30'] },
})

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validateEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const eventName = String(input.event_name || '')
  const rules = EVENT_RULES[eventName]
  if (!rules || !isUuid(input.event_id) || !isUuid(input.session_id)) return null
  if (input.anonymous_id != null && !isUuid(input.anonymous_id)) return null

  const properties = input.properties == null ? {} : input.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const allowed = Object.keys(rules)
  if (Object.keys(properties).some((key) => !allowed.includes(key))) return null
  const normalized = {}
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== 'string' || !rules[key].includes(value)) return null
    normalized[key] = value
  }

  const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date()
  if (Number.isNaN(occurredAt.getTime())) return null
  if (Math.abs(Date.now() - occurredAt.getTime()) > 7 * 24 * 60 * 60 * 1000) return null
  return {
    event_id: input.event_id,
    event_name: eventName,
    session_id: input.session_id,
    anonymous_id: input.anonymous_id || null,
    occurred_at: occurredAt.toISOString(),
    properties: normalized,
  }
}

async function recordEvents(userId, inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20) {
    throw Object.assign(new Error('每次最多提交 20 条行为记录'), { statusCode: 400 })
  }
  const events = inputs.map(validateEvent)
  if (events.some((event) => !event)) {
    throw Object.assign(new Error('行为记录格式无效或包含未授权字段'), { statusCode: 400 })
  }
  const values = []
  const params = []
  for (const event of events) {
    const start = params.length + 1
    params.push(event.event_id, userId || null, event.anonymous_id, event.session_id, event.event_name, event.occurred_at, JSON.stringify(event.properties))
    values.push(`($${start}::uuid,$${start + 1}::uuid,$${start + 2}::uuid,$${start + 3}::uuid,$${start + 4},$${start + 5}::timestamptz,$${start + 6}::jsonb)`)
  }
  const { rowCount } = await db.query(
    `INSERT INTO public.product_event
       (event_id,user_id,anonymous_id,session_id,event_name,occurred_at,properties)
     VALUES ${values.join(',')}
     ON CONFLICT (event_id) DO NOTHING`,
    params,
  )
  return { accepted: rowCount || 0 }
}

async function recordServerEvent(userId, eventName, properties = {}) {
  const event = validateEvent({
    event_id: randomUUID(),
    session_id: randomUUID(),
    event_name: eventName,
    occurred_at: new Date().toISOString(),
    properties,
  })
  if (!event) return { accepted: 0 }
  return recordEvents(userId, [event])
}

function createEvent(eventName, properties, context = {}) {
  return {
    event_id: randomUUID(),
    event_name: eventName,
    session_id: context.session_id,
    anonymous_id: context.anonymous_id,
    occurred_at: new Date().toISOString(),
    properties,
  }
}

module.exports = { EVENT_RULES, validateEvent, recordEvents, recordServerEvent, createEvent }
