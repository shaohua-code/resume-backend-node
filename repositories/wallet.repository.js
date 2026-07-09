/**
 * 钱包数据仓库
 * 封装 user_wallet、balance_ledger 表的 Supabase 访问
 */

const { supabaseAdmin } = require('../supabaseClient')

/**
 * 按用户 ID 查询钱包
 * @param {string} userId
 */
async function findWalletByUserId(userId) {
  return supabaseAdmin
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
  return supabaseAdmin
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
  return supabaseAdmin
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
  return supabaseAdmin
    .from('balance_ledger')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('create_time', { ascending: false })
    .range(from, to)
}

/**
 * 写入余额流水
 * @param {Object} payload
 */
async function insertLedger(payload) {
  return supabaseAdmin
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
  return supabaseAdmin
    .from('user_wallet')
    .select('*')
    .in('user_id', userIds)
}

module.exports = {
  findWalletByUserId,
  createWallet,
  updateWallet,
  listLedgerByUser,
  insertLedger,
  findWalletsByUserIds,
}
