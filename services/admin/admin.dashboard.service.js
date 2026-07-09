/**
 * 管理后台数据大盘服务
 * 聚合统计指标、趋势图、余额消费概览、公告与系统状态
 */

const { supabaseAdmin } = require('../../supabaseClient')
const { ROLES } = require('../../utils/permissions')
const userRepo = require('../../repositories/user.repository')
const aiCallRepo = require('../../repositories/aiCall.repository')

/**
 * 获取指定表的数量，支持自定义过滤条件
 */
async function getTableCount(table, builder) {
  let query = supabaseAdmin.from(table).select('*', { count: 'exact', head: true })
  if (builder) {
    query = builder(query)
  }
  const { count } = await query
  return count || 0
}

function startOfDay(offsetDay = 0) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDay)
  return date
}

function buildRecentMonths(count = 12) {
  const months = []
  const cursor = new Date()
  cursor.setDate(1)

  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    months.push(key)
  }

  return months
}

function bucketByMonth(rows, months, predicate) {
  const counter = months.reduce((acc, key) => {
    acc[key] = 0
    return acc
  }, {})

  ;(rows || []).forEach((row) => {
    if (predicate && !predicate(row)) return
    const date = new Date(row.create_time)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (key in counter) {
      counter[key] += 1
    }
  })

  return months.map((key) => counter[key])
}

function bucketAmountByMonth(rows, months) {
  const counter = months.reduce((acc, key) => {
    acc[key] = 0
    return acc
  }, {})

  ;(rows || []).forEach((row) => {
    const date = new Date(row.create_time)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (key in counter) {
      counter[key] += Math.abs(Number(row.amount || 0))
    }
  })

  return months.map((key) => Number(counter[key].toFixed(4)))
}

/**
 * 获取管理后台顶部统计卡片数据
 */
async function getStats() {
  const [userCount, adminCount, resumeCount, aiCallCount, walletStats] = await Promise.all([
    getTableCount('user_profile'),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    aiCallRepo.countAiCalls(),
    supabaseAdmin.from('user_wallet').select('balance,total_consumed'),
  ])

  const wallets = walletStats.data || []
  const totalBalance = wallets.reduce((sum, row) => sum + Number(row.balance || 0), 0)
  const totalConsumed = wallets.reduce((sum, row) => sum + Number(row.total_consumed || 0), 0)

  const { data: aiTasks } = await aiCallRepo.findRecentTaskTypes(500)
  const aiTaskMap = (aiTasks || []).reduce((acc, item) => {
    acc[item.task_type] = (acc[item.task_type] || 0) + 1
    return acc
  }, {})

  return {
    user_count: userCount,
    admin_count: adminCount,
    resume_count: resumeCount,
    ai_call_count: aiCallCount,
    total_balance: Number(totalBalance.toFixed(2)),
    total_consumed: Number(totalConsumed.toFixed(2)),
    ai_task_stats: Object.entries(aiTaskMap).map(([task_type, count]) => ({ task_type, count })),
  }
}

/**
 * 获取管理后台数据中心大盘数据
 */
async function getDashboard() {
  const todayStart = startOfDay(0).toISOString()
  const yesterdayStart = startOfDay(-1).toISOString()
  const months = buildRecentMonths(12)
  const yearStart = new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1).toISOString()

  const [userCount, adminCount, resumeCount, todayNewUsers, yesterdayNewUsers, walletStats, ledgerStats] = await Promise.all([
    getTableCount('user_profile'),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    userRepo.countUsers((query) => query.gte('create_time', todayStart)),
    userRepo.countUsers((query) => query.gte('create_time', yesterdayStart).lt('create_time', todayStart)),
    supabaseAdmin.from('user_wallet').select('balance,total_consumed'),
    supabaseAdmin
      .from('balance_ledger')
      .select('amount,type,create_time')
      .gte('create_time', yearStart),
  ])

  const wallets = walletStats.data || []
  const totalBalance = wallets.reduce((sum, row) => sum + Number(row.balance || 0), 0)
  const totalConsumed = wallets.reduce((sum, row) => sum + Number(row.total_consumed || 0), 0)

  const ledgerRows = ledgerStats.data || []
  const aiConsumeRows = ledgerRows.filter((row) => row.type === 'AI_CONSUME')
  const grantRows = ledgerRows.filter((row) => row.type === 'ADMIN_GRANT' || row.type === 'REGISTER_GIFT')

  const [{ data: userRows }, { data: aiRows }] = await Promise.all([
    supabaseAdmin
      .from('user_profile')
      .select('create_time,role')
      .gte('create_time', yearStart),
    aiCallRepo.findAllAiCalls(yearStart),
  ])

  const userTrend = bucketByMonth(userRows, months)
  const consumeTrend = bucketAmountByMonth(aiConsumeRows, months)
  const grantTrend = bucketAmountByMonth(grantRows, months)
  const aiTrend = bucketByMonth(aiRows, months, () => true)

  const { data: announcements } = await supabaseAdmin
    .from('announcement')
    .select('id,title,enabled,create_time')
    .order('create_time', { ascending: false })
    .limit(5)

  const { error: dbError } = await supabaseAdmin.from('system_config').select('config_key').limit(1)
  const systemStatus = {
    api: 'ok',
    db: dbError ? 'error' : 'ok',
    ai: 'ok',
    storage: 'ok',
  }

  return {
    user_count: userCount,
    admin_count: adminCount,
    resume_count: resumeCount,
    ai_call_count: aiTrend.reduce((sum, value) => sum + value, 0),
    today_new_users: todayNewUsers,
    user_growth: todayNewUsers - yesterdayNewUsers,
    total_balance: Number(totalBalance.toFixed(2)),
    total_consumed: Number(totalConsumed.toFixed(2)),
    months,
    user_trend: userTrend,
    consume_trend: consumeTrend,
    grant_trend: grantTrend,
    ai_trend: aiTrend,
    recent_announcements: announcements || [],
    system_status: systemStatus,
  }
}

module.exports = {
  getStats,
  getDashboard,
}
