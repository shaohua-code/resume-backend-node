/**
 * 钱包数据仓库
 * 封装 user_wallet、balance_ledger 表的 PostgreSQL 访问
 */

const { dbAdmin } = require('../dbClient')

/**
 * 按用户 ID 查询钱包
 * @param {string} userId
 */
async function findWalletByUserId(userId) {
  return dbAdmin
    .from('user_wallet')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
}

/**
 * 创建用户钱包
 * @param {Object} payload
 */
async function createWallet(payload) {
  return dbAdmin
    .from('user_wallet')
    .insert(payload)
    .select()
    .single()
}

/**
 * 更新用户钱包余额
 * @param {string} userId
 * @param {Object} payload
 */
async function updateWallet(userId, payload) {
  return dbAdmin
    .from('user_wallet')
    .update(payload)
    .eq('user_id', userId)
    .select()
    .single()
}

/**
 * 分页查询用户流水
 * @param {string} userId
 * @param {number} from
 * @param {number} to
 */
async function listLedgerByUser(userId, from, to) {
  return dbAdmin
    .from('balance_ledger')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('create_time', { ascending: false })
    .range(from, to)
}

/**
 * 分页查询流水（支持多用户、类型筛选）
 * @param {Object} params
 */
async function listLedger({ from, to, userId, type, userIds }) {
  let query = dbAdmin
    .from('balance_ledger')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to)

  if (userIds !== undefined && userIds !== null) {
    if (!userIds.length) {
      query = query.eq('user_id', '00000000-0000-0000-0000-000000000000')
    } else {
      query = query.in('user_id', userIds)
    }
  }

  if (userId) query = query.eq('user_id', userId)
  if (type) query = query.eq('type', type)

  return query
}

/**
 * 查询实付金额合计（按操作者或用户范围，仅 ADMIN_GRANT 接收方流水）
 * @param {Object} params
 * @returns {Promise<number>}
 */
async function sumPaidAmount({ operatorId, userIds }) {
  let query = dbAdmin
    .from('balance_ledger')
    .select('paid_amount')
    .eq('type', 'ADMIN_GRANT')
    .gt('amount', 0)
    .gt('paid_amount', 0)

  if (operatorId) query = query.eq('operator_id', operatorId)
  if (userIds !== undefined && userIds !== null) {
    if (!userIds.length) return 0
    query = query.in('user_id', userIds)
  }

  const { data, error } = await query
  if (error) return 0
  return (data || []).reduce((sum, row) => sum + Number(row.paid_amount || 0), 0)
}

/**
 * 写入余额流水
 * @param {Object} payload
 */
async function insertLedger(payload) {
  return dbAdmin
    .from('balance_ledger')
    .insert(payload)
    .select()
    .single()
}

/**
 * 批量查询多个用户的钱包
 * @param {string[]} userIds
 */
async function findWalletsByUserIds(userIds) {
  if (!userIds.length) {
    return { data: [], error: null }
  }
  return dbAdmin
    .from('user_wallet')
    .select('*')
    .in('user_id', userIds)
}

module.exports = {
  findWalletByUserId,
  createWallet,
  updateWallet,
  listLedgerByUser,
  listLedger,
  insertLedger,
  findWalletsByUserIds,
  sumPaidAmount,
}
