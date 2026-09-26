const db = require('../../lib/db')

const GOAL_STATUSES = new Set(['active', 'paused', 'completed'])

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

function normalize(input, { partial = false } = {}) {
  const output = {}
  const fields = [
    ['name', 80], ['job_direction', 120], ['target_city', 120],
    ['career_stage', 40], ['salary_expectation', 80],
  ]
  for (const [key, max] of fields) {
    if (!partial || input[key] !== undefined) output[key] = cleanText(input[key], max)
  }
  if (!partial && !output.name) throw Object.assign(new Error('请填写求职目标名称'), { statusCode: 400 })
  if (partial && output.name !== undefined && !output.name) throw Object.assign(new Error('目标名称不能为空'), { statusCode: 400 })
  if (partial && input.status !== undefined) {
    output.status = String(input.status)
    if (!GOAL_STATUSES.has(output.status)) throw Object.assign(new Error('目标状态无效'), { statusCode: 400 })
  }
  if (input.is_primary !== undefined) output.is_primary = Boolean(input.is_primary)
  return output
}

async function list(userId) {
  const { rows } = await db.query(
    `SELECT g.*, COUNT(j.id)::int AS job_count,
            COUNT(j.id) FILTER (WHERE j.application_stage IN ('preparing','applied','interviewing'))::int AS in_progress_count
     FROM public.career_goal g
     LEFT JOIN public.extension_saved_job j ON j.career_goal_id = g.id AND j.user_id = g.user_id AND j.application_stage <> 'archived'
     WHERE g.user_id = $1
     GROUP BY g.id
     ORDER BY g.is_primary DESC, CASE g.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, g.update_time DESC`,
    [userId],
  )
  return rows
}

async function create(userId, input) {
  const goal = normalize(input)
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(userId)])
    const { rows: existing } = await client.query('SELECT id FROM public.career_goal WHERE user_id = $1 LIMIT 1', [userId])
    const primary = goal.is_primary || !existing.length
    if (primary) await client.query('UPDATE public.career_goal SET is_primary = false WHERE user_id = $1', [userId])
    const { rows } = await client.query(
      `INSERT INTO public.career_goal (user_id,name,job_direction,target_city,career_stage,salary_expectation,is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [userId, goal.name, goal.job_direction, goal.target_city, goal.career_stage, goal.salary_expectation, primary],
    )
    await client.query('COMMIT')
    return rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function update(userId, goalId, input) {
  const id = Number(goalId)
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('求职目标不存在'), { statusCode: 404 })
  const values = normalize(input, { partial: true })
  const keys = Object.keys(values)
  if (!keys.length) throw Object.assign(new Error('没有可更新的目标信息'), { statusCode: 400 })
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(userId)])
    const { rows: current } = await client.query('SELECT id, is_primary, status FROM public.career_goal WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id])
    if (!current.length) throw Object.assign(new Error('求职目标不存在'), { statusCode: 404 })
    if (values.is_primary === true && (values.status || current[0].status) !== 'active') {
      throw Object.assign(new Error('只有进行中的目标可以设为当前目标'), { statusCode: 400 })
    }
    const demote = values.is_primary === false || (values.status && values.status !== 'active')
    const promote = values.is_primary === true && (!values.status || values.status === 'active')
    if (promote) await client.query('UPDATE public.career_goal SET is_primary=false WHERE user_id=$1 AND id<>$2', [userId, id])
    if (demote) values.is_primary = false
    const allowed = new Set(['name','job_direction','target_city','career_stage','salary_expectation','status','is_primary'])
    const sets = keys.filter((key) => allowed.has(key)).map((key, index) => `${key}=$${index + 3}`)
    const params = keys.map((key) => values[key])
    sets.push('update_time=now()')
    const { rows } = await client.query(
      `UPDATE public.career_goal SET ${sets.join(',')} WHERE user_id=$1 AND id=$2 RETURNING *`,
      [userId, id, ...params],
    )
    if (current[0].is_primary && demote) {
      await client.query(
        `UPDATE public.career_goal SET is_primary=true, update_time=now()
         WHERE id=(SELECT id FROM public.career_goal WHERE user_id=$1 AND status='active' AND id<>$2 ORDER BY update_time DESC LIMIT 1)`,
        [userId, id],
      )
    }
    await client.query('COMMIT')
    return rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function remove(userId, goalId) {
  const id = Number(goalId)
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(userId)])
    const { rows } = await client.query('DELETE FROM public.career_goal WHERE user_id=$1 AND id=$2 RETURNING is_primary', [userId, id])
    if (!rows.length) throw Object.assign(new Error('求职目标不存在'), { statusCode: 404 })
    if (rows[0].is_primary) {
      await client.query(
        `UPDATE public.career_goal SET is_primary=true, update_time=now()
         WHERE id=(SELECT id FROM public.career_goal WHERE user_id=$1 AND status='active' ORDER BY update_time DESC LIMIT 1)`,
        [userId],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

module.exports = { list, create, update, remove }
