/**
 * 管理后台数据大盘服务
 * 聚合统计指标、趋势图、余额消费概览、公告与系统状态
 * 普通管理员仅统计归属用户；超级管理员看全站
 */

const { dbAdmin } = require('../../dbClient')
const { ROLES } = require('../../utils/permissions')
const userRepo = require('../../repositories/user.repository')
const aiCallRepo = require('../../repositories/aiCall.repository')
const walletService = require('../wallet/wallet.service')
const { getOwnedUserIds } = require('./admin.common.service')

/** 空归属列表时用于强制无结果的占位 UUID */
const EMPTY_SCOPE_USER_ID = '00000000-0000-0000-0000-000000000000'

/**
 * 按归属用户过滤查询：null 不过滤；空数组强制无结果；否则 .in(user_id)
 * @param {Object} query
 * @param {string[]|null} ownedUserIds
 */
function applyUserScope(query, ownedUserIds) {
  if (ownedUserIds === null || ownedUserIds === undefined) return query
  if (!ownedUserIds.length) {
    return query.eq('user_id', EMPTY_SCOPE_USER_ID)
  }
  return query.in('user_id', ownedUserIds)
}

/**
 * 获取指定表的数量，支持自定义过滤条件
 */
async function getTableCount(table, builder) {
  let query = dbAdmin.from(table).select('*', { count: 'exact', head: true })
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
 * 读取当前登录管理员自己的钱包余额、累计 AI 消费、累计额度发放
 * @param {Object} req Express 请求对象
 */
async function getMyWalletStats(req) {
  if (!req?.user) {
    return { my_balance: 0, my_consumed: 0, my_granted: 0 }
  }

  try {
    const [balanceInfo, grantStats] = await Promise.all([
      walletService.getBalance(req.user.id, req.user.role),
      // 累计发放：自己钱包上全部 ADMIN_GRANT 扣款（绝对值之和）
      dbAdmin
        .from('balance_ledger')
        .select('amount')
        .eq('type', 'ADMIN_GRANT')
        .eq('user_id', req.user.id)
        .lt('amount', 0),
    ])

    const grantRows = grantStats.data || []
    const myGranted = grantRows.reduce(
      (sum, row) => sum + Math.abs(Number(row.amount || 0)),
      0,
    )

    return {
      my_balance: balanceInfo.balance,
      my_consumed: balanceInfo.total_consumed,
      my_granted: Number(myGranted.toFixed(2)),
    }
  } catch (e) {
    console.error('[dashboard] 获取个人钱包统计失败:', e.message)
    return { my_balance: 0, my_consumed: 0, my_granted: 0 }
  }
}

/**
 * 获取管理后台顶部统计卡片数据
 * @param {Object} req Express 请求对象
 */
async function getStats(req) {
  // 普通管理员仅看归属用户；超管 ownedUserIds 为 null
  const ownedUserIds = await getOwnedUserIds(req.user)

  const [userCount, adminCount, resumeCount, aiCallCount, myWalletStats] = await Promise.all([
    getTableCount('user_profile', (query) => applyUserScope(query, ownedUserIds)),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume', (query) => applyUserScope(query, ownedUserIds)),
    aiCallRepo.countAiCalls((query) => applyUserScope(query, ownedUserIds)),
    getMyWalletStats(req),
  ])

  const { data: aiTasks } = await aiCallRepo.findRecentTaskTypes(500, ownedUserIds)
  const aiTaskMap = (aiTasks || []).reduce((acc, item) => {
    acc[item.task_type] = (acc[item.task_type] || 0) + 1
    return acc
  }, {})

  return {
    user_count: userCount,
    admin_count: adminCount,
    resume_count: resumeCount,
    ai_call_count: aiCallCount,
    my_balance: myWalletStats.my_balance,
    my_consumed: myWalletStats.my_consumed,
    my_granted: myWalletStats.my_granted,
    ai_task_stats: Object.entries(aiTaskMap).map(([task_type, count]) => ({ task_type, count })),
  }
}

/**
 * 根据时间范围字符串计算起始日期
 * @param {string} range - 时间范围（今日/昨日/7日/30日/年度）
 * @returns {Date} 起始日期
 */
function getRangeStartDate(range) {
  const now = new Date()

  switch (range) {
    case '今日':
      return startOfDay(0)  // 今天 00:00:00
    case '昨日':
      return startOfDay(-1)  // 昨天 00:00:00
    case '7日':
      return startOfDay(-7)  // 7天前 00:00:00
    case '30日':
      return startOfDay(-30)  // 30天前 00:00:00
    case '年度':
    default:
      // 默认：去年同月1日到现在（12个月数据）
      return new Date(now.getFullYear() - 1, now.getMonth(), 1)
  }
}

/**
 * 根据时间范围获取月份列表
 * @param {string} range - 时间范围
 * @returns {string[]} 月份 key 数组
 */
function getRangeMonths(range) {
  if (range === '年度') {
    return buildRecentMonths(12)  // 12个月
  }
  // 其他范围：只返回当前月份（用于单点统计，不显示趋势图）
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return [key]
}

/**
 * 获取管理后台数据中心大盘数据
 * @param {Object} req - Express 请求对象（包含查询参数 range）
 */
async function getDashboard(req) {
  // 从查询参数获取时间范围，默认为"年度"
  const range = (req && req.query && req.query.range) || '年度'
  const rangeStart = getRangeStartDate(range).toISOString()
  const months = getRangeMonths(range)

  const todayStart = startOfDay(0).toISOString()
  const yesterdayStart = startOfDay(-1).toISOString()

  // 普通管理员仅统计归属用户；超管不过滤
  const ownedUserIds = await getOwnedUserIds(req.user)

  const [userCount, adminCount, resumeCount, todayNewUsers, yesterdayNewUsers, myWalletStats, consumeLedgerStats, grantLedgerStats] = await Promise.all([
    getTableCount('user_profile', (query) => applyUserScope(query, ownedUserIds)),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume', (query) => applyUserScope(query, ownedUserIds)),
    userRepo.countUsers((query) => applyUserScope(query.gte('create_time', todayStart), ownedUserIds)),
    userRepo.countUsers((query) => applyUserScope(
      query.gte('create_time', yesterdayStart).lt('create_time', todayStart),
      ownedUserIds,
    )),
    getMyWalletStats(req),
    // AI 消费趋势：仅当前管理员自己的 AI_CONSUME（与「累计消费」卡片口径一致）
    dbAdmin
      .from('balance_ledger')
      .select('amount,type,create_time,user_id')
      .eq('type', 'AI_CONSUME')
      .eq('user_id', req.user.id)
      .gte('create_time', rangeStart),
    // 额度发放：仅当前管理员自己钱包上的 ADMIN_GRANT 扣款
    dbAdmin
      .from('balance_ledger')
      .select('amount,type,create_time,user_id')
      .eq('type', 'ADMIN_GRANT')
      .eq('user_id', req.user.id)
      .lt('amount', 0)
      .gte('create_time', rangeStart),
  ])

  const aiConsumeRows = consumeLedgerStats.data || []
  const grantRows = grantLedgerStats.data || []

  let userTrendQuery = dbAdmin
    .from('user_profile')
    .select('create_time,role,user_id')
    .gte('create_time', rangeStart)
  userTrendQuery = applyUserScope(userTrendQuery, ownedUserIds)

  const [{ data: userRows }, { data: aiRows }] = await Promise.all([
    userTrendQuery,
    aiCallRepo.findAllAiCalls(rangeStart, ownedUserIds),
  ])

  const userTrend = bucketByMonth(userRows, months)
  const consumeTrend = bucketAmountByMonth(aiConsumeRows, months)
  const grantTrend = bucketAmountByMonth(grantRows, months)
  const aiTrend = bucketByMonth(aiRows, months, () => true)

  const { data: announcements } = await dbAdmin
    .from('announcement')
    .select('id,title,enabled,create_time')
    .order('create_time', { ascending: false })
    .limit(5)

  const { error: dbError } = await dbAdmin.from('system_config').select('config_key').limit(1)
  const systemStatus = {
    api: 'ok',
    db: dbError ? 'error' : 'ok',
    ai: 'ok',
    storage: 'ok',
  }

  // 当前管理员个人钱包数据（余额、AI 消费、额度发放总额）
  const { my_balance: myBalance, my_consumed: myConsumed, my_granted: myGranted } = myWalletStats

  return {
    user_count: userCount,
    admin_count: adminCount,
    resume_count: resumeCount,
    ai_call_count: aiTrend.reduce((sum, value) => sum + value, 0),
    today_new_users: todayNewUsers,
    user_growth: todayNewUsers - yesterdayNewUsers,
    my_balance: myBalance,
    my_consumed: myConsumed,
    my_granted: myGranted,
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
