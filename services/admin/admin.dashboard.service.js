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

// 统一把本地日历时间转换成图表桶键，保证筛选区间、对比区间和展示粒度一致。
function formatDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

// 将前端枚举限定在已知范围，并预先构造展示桶与等时长比较区间。
function getRangeDefinition(range, now = new Date()) {
  const startToday = startOfDay(0)
  const dayMs = 24 * 60 * 60 * 1000
  const safeRange = ['今日', '昨日', '7日', '30日', '年度'].includes(range) ? range : '年度'

  if (safeRange === '今日' || safeRange === '昨日') {
    const start = safeRange === '今日' ? startToday : new Date(startToday.getTime() - dayMs)
    const end = safeRange === '今日' ? now : new Date(start.getTime() + dayMs)
    const previousStart = new Date(start.getTime() - dayMs)
    const previousEnd = safeRange === '今日' ? new Date(previousStart.getTime() + (now.getTime() - start.getTime())) : start
    const labels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
    const keys = labels.map((_, hour) => `${formatDateKey(start)}T${String(hour).padStart(2, '0')}`)
    return { range: safeRange, granularity: 'hour', start, end, previousStart, previousEnd, labels, keys }
  }

  if (safeRange === '7日' || safeRange === '30日') {
    const days = safeRange === '7日' ? 7 : 30
    const start = new Date(startToday.getTime() - (days - 1) * dayMs)
    const previousStart = new Date(start.getTime() - (now.getTime() - start.getTime()))
    const labels = Array.from({ length: days }, (_, index) => {
      const date = new Date(start.getTime() + index * dayMs)
      return `${date.getMonth() + 1}/${date.getDate()}`
    })
    const keys = Array.from({ length: days }, (_, index) => formatDateKey(new Date(start.getTime() + index * dayMs)))
    return { range: safeRange, granularity: 'day', start, end: now, previousStart, previousEnd: start, labels, keys }
  }

  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const previousStart = new Date(start.getTime() - (now.getTime() - start.getTime()))
  const labels = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1)
    return `${date.getFullYear()}年${date.getMonth() + 1}月`
  })
  const keys = Array.from({ length: 12 }, (_, index) => formatMonthKey(new Date(start.getFullYear(), start.getMonth() + index, 1)))
  return { range: safeRange, granularity: 'month', start, end: now, previousStart, previousEnd: start, labels, keys }
}

// 将时间戳映射到与筛选器对应的小时、日期或月份桶，空桶固定补零。
function getBucketKey(value, granularity) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  if (granularity === 'hour') return `${formatDateKey(date)}T${String(date.getHours()).padStart(2, '0')}`
  if (granularity === 'day') return formatDateKey(date)
  return formatMonthKey(date)
}

function bucketRows(rows, definition, selectValue = () => 1) {
  const counter = Object.fromEntries(definition.keys.map((key) => [key, 0]))
  ;(rows || []).forEach((row) => {
    const key = getBucketKey(row.create_time, definition.granularity)
    if (key in counter) counter[key] += Number(selectValue(row) || 0)
  })
  return definition.keys.map((key) => Number(counter[key].toFixed(4)))
}

// 对比卡片只返回可验证的绝对差；基期为零时百分比留空，避免伪造增长率。
function buildComparison(value, previous) {
  return {
    value,
    previous,
    change: value - previous,
    change_rate: previous === 0 ? null : Number((((value - previous) / previous) * 100).toFixed(1)),
  }
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
 * 获取管理后台数据中心大盘数据
 * @param {Object} req - Express 请求对象（包含查询参数 range）
 */
async function getDashboard(req) {
  // 先固定有效筛选范围与等长前置周期，所有区间卡片与趋势都复用同一口径。
  const range = (req && req.query && req.query.range) || '年度'
  const definition = getRangeDefinition(range)
  const startIso = definition.start.toISOString()
  const endIso = definition.end.toISOString()
  const previousStartIso = definition.previousStart.toISOString()
  const previousEndIso = definition.previousEnd.toISOString()
  const ownedUserIds = await getOwnedUserIds(req.user)
  const userScope = (query) => applyUserScope(query, ownedUserIds)

  const rangeFilter = (start, end) => (query) => userScope(query.gte('create_time', start).lt('create_time', end))
  const [userCount, resumeCount, currentUsers, previousUsers, currentResumes, previousResumes, currentAiCount, previousAiCount,
    myWalletStats, consumeLedgerStats, grantLedgerStats] = await Promise.all([
    getTableCount('user_profile', userScope),
    getTableCount('resume', userScope),
    userRepo.countUsers(rangeFilter(startIso, endIso)),
    userRepo.countUsers(rangeFilter(previousStartIso, previousEndIso)),
    getTableCount('resume', rangeFilter(startIso, endIso)),
    getTableCount('resume', rangeFilter(previousStartIso, previousEndIso)),
    aiCallRepo.countAiCalls(rangeFilter(startIso, endIso)),
    aiCallRepo.countAiCalls(rangeFilter(previousStartIso, previousEndIso)),
    getMyWalletStats(req),
    dbAdmin.from('balance_ledger').select('amount,create_time').eq('type', 'AI_CONSUME')
      .eq('user_id', req.user.id).gte('create_time', startIso).lt('create_time', endIso),
    dbAdmin.from('balance_ledger').select('amount,create_time').eq('type', 'ADMIN_GRANT')
      .eq('user_id', req.user.id).lt('amount', 0).gte('create_time', startIso).lt('create_time', endIso),
  ])

  // 当前区间明细只取图表所需字段，归属范围由同一管理员边界统一限定。
  let userTrendQuery = dbAdmin.from('user_profile').select('create_time').gte('create_time', startIso).lt('create_time', endIso)
  userTrendQuery = userScope(userTrendQuery)
  const [{ data: userRows }, { data: aiRows }] = await Promise.all([
    userTrendQuery,
    aiCallRepo.findAllAiCalls(startIso, endIso, ownedUserIds),
  ])

  const uniqueActiveUsers = new Set((aiRows || []).map((row) => row.user_id).filter(Boolean)).size
  const { data: announcements } = await dbAdmin
    .from('announcement').select('id,title,enabled,create_time')
    .order('create_time', { ascending: false }).limit(5)

  const { my_balance: myBalance, my_consumed: myConsumed, my_granted: myGranted } = myWalletStats
  const aiConsumeRows = consumeLedgerStats.data || []
  const grantRows = grantLedgerStats.data || []

  return {
    range: definition.range,
    range_start: startIso,
    range_end: endIso,
    scope: ownedUserIds === null ? 'all' : 'owned',
    user_count: userCount,
    resume_count: resumeCount,
    period_summary: {
      users: buildComparison(currentUsers, previousUsers),
      resumes: buildComparison(currentResumes, previousResumes),
      ai_calls: buildComparison(currentAiCount, previousAiCount),
      active_users: uniqueActiveUsers,
    },
    my_balance: myBalance,
    my_consumed: myConsumed,
    my_granted: myGranted,
    labels: definition.labels,
    user_trend: bucketRows(userRows, definition),
    ai_trend: bucketRows(aiRows, definition),
    consume_trend: bucketRows(aiConsumeRows, definition, (row) => Math.abs(Number(row.amount || 0))),
    grant_trend: bucketRows(grantRows, definition, (row) => Math.abs(Number(row.amount || 0))),
    recent_announcements: announcements || [],
  }
}

module.exports = {
  getStats,
  getDashboard,
}
