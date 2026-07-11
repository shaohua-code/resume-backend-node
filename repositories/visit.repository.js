/**
 * 访客记录数据仓库
 */

const { dbAdmin } = require('../dbClient')

const RETENTION_DAYS = 30

async function insertVisit(payload) {
  return dbAdmin.from('visit_log').insert(payload).select('id').single()
}

async function updateDuration(id, durationSeconds) {
  return dbAdmin
    .from('visit_log')
    .update({ duration_seconds: durationSeconds })
    .eq('id', id)
    .select('id')
    .single()
}

async function deleteOlderThan(days = RETENTION_DAYS) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return dbAdmin.from('visit_log').delete().lt('visit_time', cutoff.toISOString())
}

async function listVisits({ from, to, keyword }) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)

  let query = dbAdmin
    .from('visit_log')
    .select('*', { count: 'exact' })
    .gte('visit_time', cutoff.toISOString())
    .order('visit_time', { ascending: false })
    .range(from, to)

  const kw = String(keyword || '').trim()
  if (kw) {
    query = query.or(`user_email.ilike.%${kw}%,ip_address.ilike.%${kw}%`)
  }
  return query
}

module.exports = {
  RETENTION_DAYS,
  insertVisit,
  updateDuration,
  deleteOlderThan,
  listVisits,
}
