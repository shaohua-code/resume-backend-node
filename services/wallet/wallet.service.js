/**
 * 钱包业务服务
 * 负责余额查询、注册赠送、AI 扣费、管理员增减额度
 */

const walletRepo = require('../../repositories/wallet.repository')
const userRepo = require('../../repositories/user.repository')
const { ROLES, PERMISSIONS, hasPermission, canManageRole } = require('../../utils/permissions')
const { logAdminAction } = require('../admin/admin.common.service')

// 流水类型枚举
const LEDGER_TYPES = {
  REGISTER_GIFT: 'REGISTER_GIFT',
  ADMIN_GRANT: 'ADMIN_GRANT',
  ADMIN_DEDUCT: 'ADMIN_DEDUCT',
  AI_CONSUME: 'AI_CONSUME',
  REFUND: 'REFUND',
}

// AI 调用前最低余额门槛（元）
const MIN_AI_BALANCE = 0.01

/**
 * 从系统配置读取新用户注册赠送金额
 * @returns {Promise<number>}
 */
async function getRegisterGiftAmount() {
  const { supabaseAdmin } = require('../../supabaseClient')
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'register_gift_amount')
    .maybeSingle()
  const amount = data?.config_value?.amount
  return Number(amount ?? 10)
}

/**
 * 格式化金额，保留 4 位小数
 * @param {number} value
 */
function roundMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000
}

/**
 * 确保用户有钱包记录，没有则返回 null
 * @param {string} userId
 */
async function getWalletOrNull(userId) {
  const { data, error } = await walletRepo.findWalletByUserId(userId)
  if (error) {
    throw Object.assign(new Error(`查询钱包失败：${error.message}`), { statusCode: 500 })
  }
  return data
}

/**
 * 新用户注册后初始化钱包并写入注册赠送流水
 * @param {string} userId
 */
async function initWalletForNewUser(userId) {
  const existing = await getWalletOrNull(userId)
  if (existing) {
    return existing
  }

  const giftAmount = await getRegisterGiftAmount()
  const now = new Date().toISOString()

  const { data: wallet, error: walletError } = await walletRepo.createWallet({
    user_id: userId,
    balance: giftAmount,
    total_consumed: 0,
    update_time: now,
  })

  if (walletError) {
    throw Object.assign(new Error(`创建钱包失败：${walletError.message}`), { statusCode: 500 })
  }

  const { error: ledgerError } = await walletRepo.insertLedger({
    user_id: userId,
    type: LEDGER_TYPES.REGISTER_GIFT,
    amount: giftAmount,
    balance_after: giftAmount,
    remark: '新用户注册赠送',
    create_time: now,
  })

  if (ledgerError) {
    throw Object.assign(new Error(`写入注册赠送流水失败：${ledgerError.message}`), { statusCode: 500 })
  }

  return wallet
}

/**
 * 获取用户余额信息
 * @param {string} userId
 */
async function getBalance(userId) {
  let wallet = await getWalletOrNull(userId)
  if (!wallet) {
    wallet = await initWalletForNewUser(userId)
  }
  return {
    balance: roundMoney(wallet.balance),
    total_consumed: roundMoney(wallet.total_consumed),
    update_time: wallet.update_time,
  }
}

/**
 * 分页查询用户流水
 * @param {string} userId
 * @param {number} page
 * @param {number} size
 */
async function listLedger(userId, page, size) {
  const from = (page - 1) * size
  const to = page * size - 1
  const { data, error, count } = await walletRepo.listLedgerByUser(userId, from, to)

  if (error) {
    throw Object.assign(new Error(`查询流水失败：${error.message}`), { statusCode: 500 })
  }

  return {
    total: count || 0,
    items: (data || []).map((row) => ({
      ...row,
      amount: roundMoney(row.amount),
      balance_after: roundMoney(row.balance_after),
      create_time: String(row.create_time),
    })),
  }
}

/**
 * 内部方法：变更余额并写流水
 * @param {Object} options
 */
async function changeBalance({ userId, delta, type, remark, operatorId = null, aiCallId = null }) {
  const wallet = await getWalletOrNull(userId)
  if (!wallet) {
    throw Object.assign(new Error('用户钱包不存在'), { statusCode: 404 })
  }

  const currentBalance = roundMoney(wallet.balance)
  const nextBalance = roundMoney(currentBalance + delta)

  if (nextBalance < 0) {
    const err = new Error('账户余额不足，请先充值或联系管理员')
    err.code = 'INSUFFICIENT_BALANCE'
    err.statusCode = 402
    throw err
  }

  const totalConsumed = roundMoney(
    Number(wallet.total_consumed || 0) + (delta < 0 ? Math.abs(delta) : 0),
  )
  const now = new Date().toISOString()

  const { error: updateError } = await walletRepo.updateWallet(userId, {
    balance: nextBalance,
    total_consumed: totalConsumed,
    update_time: now,
  })

  if (updateError) {
    throw Object.assign(new Error(`更新余额失败：${updateError.message}`), { statusCode: 500 })
  }

  const { data: ledger, error: ledgerError } = await walletRepo.insertLedger({
    user_id: userId,
    type,
    amount: roundMoney(delta),
    balance_after: nextBalance,
    remark: remark || '',
    operator_id: operatorId,
    ai_call_id: aiCallId,
    create_time: now,
  })

  if (ledgerError) {
    throw Object.assign(new Error(`写入流水失败：${ledgerError.message}`), { statusCode: 500 })
  }

  return { balance: nextBalance, ledger }
}

/**
 * AI 调用前校验余额是否足够
 * @param {string} userId
 * @param {number} [estimatedCost=MIN_AI_BALANCE]
 */
async function ensureSufficientBalance(userId, estimatedCost = MIN_AI_BALANCE) {
  const { balance } = await getBalance(userId)
  if (balance < estimatedCost) {
    const err = new Error(`账户余额不足（当前 ¥${balance.toFixed(2)}），请先充值或联系管理员`)
    err.code = 'INSUFFICIENT_BALANCE'
    err.statusCode = 402
    throw err
  }
}

/**
 * AI 调用成功后按实际费用扣费
 * @param {string} userId
 * @param {number} cost
 * @param {number} aiCallId
 * @param {string} taskType
 */
async function deductForAiCall(userId, cost, aiCallId, taskType) {
  const actualCost = roundMoney(cost)
  if (actualCost <= 0) {
    return { balance: (await getBalance(userId)).balance, deducted: 0 }
  }

  const result = await changeBalance({
    userId,
    delta: -actualCost,
    type: LEDGER_TYPES.AI_CONSUME,
    remark: `AI 消费：${taskType}`,
    aiCallId,
  })

  return { balance: result.balance, deducted: actualCost }
}

/**
 * AI 调用失败时回滚已扣费用（可选）
 * @param {string} userId
 * @param {number} cost
 * @param {string} remark
 */
async function refundAiCall(userId, cost, remark = 'AI 调用失败退款') {
  const refundAmount = roundMoney(cost)
  if (refundAmount <= 0) {
    return null
  }
  return changeBalance({
    userId,
    delta: refundAmount,
    type: LEDGER_TYPES.REFUND,
    remark,
  })
}

/**
 * 管理员调整用户额度
 * @param {Object} operator - 操作者 req.user
 * @param {string} targetUserId
 * @param {number} amount - 正数增加，负数扣减
 * @param {string} remark
 */
async function adjustBalanceByAdmin(operator, targetUserId, amount, remark = '') {
  const delta = roundMoney(amount)
  if (!delta || Number.isNaN(delta)) {
    throw Object.assign(new Error('调整金额不能为空或 0'), { statusCode: 400 })
  }

  const { data: target } = await userRepo.findById(targetUserId)
  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
  }

  // 扣减仅超级管理员可操作
  if (delta < 0) {
    if (!hasPermission(operator.role, PERMISSIONS.WALLET_MANAGE_USERS)) {
      throw Object.assign(new Error('仅超级管理员可扣减用户额度'), { statusCode: 403 })
    }
  } else if (!hasPermission(operator.role, PERMISSIONS.WALLET_GRANT_USERS)
    && !hasPermission(operator.role, PERMISSIONS.WALLET_MANAGE_USERS)) {
    throw Object.assign(new Error('无权调整用户额度'), { statusCode: 403 })
  }

  // 普通管理员只能给 USER 角色增加额度
  if (operator.role === ROLES.ADMIN) {
    if (target.role !== ROLES.USER) {
      throw Object.assign(new Error('管理员仅可为普通用户增加额度'), { statusCode: 403 })
    }
    if (delta < 0) {
      throw Object.assign(new Error('管理员无法扣减用户额度'), { statusCode: 403 })
    }
  } else if (!canManageRole(operator.role, target.role) && operator.id !== target.user_id) {
    throw Object.assign(new Error('无权操作该用户'), { statusCode: 403 })
  }

  // 确保目标用户有钱包
  await getBalance(targetUserId)

  const ledgerType = delta > 0 ? LEDGER_TYPES.ADMIN_GRANT : LEDGER_TYPES.ADMIN_DEDUCT
  const result = await changeBalance({
    userId: targetUserId,
    delta,
    type: ledgerType,
    remark: remark || (delta > 0 ? '管理员增加额度' : '管理员扣减额度'),
    operatorId: operator.id,
  })

  return {
    user_id: targetUserId,
    balance: result.balance,
    amount: delta,
  }
}

/**
 * 管理端分页查询用户钱包列表
 * @param {Object} req
 * @param {number} from
 * @param {number} to
 */
async function listWalletsForAdmin(req, from, to) {
  const keyword = (req.query.keyword || '').trim()
  const { data: profiles, error, count } = await userRepo.listUsers({
    from,
    to,
    keyword,
    adminRole: req.user.role,
  })

  if (error) {
    throw Object.assign(new Error(`查询用户列表失败：${error.message}`), { statusCode: 500 })
  }

  const userIds = (profiles || []).map((row) => row.user_id)
  const { data: wallets } = await walletRepo.findWalletsByUserIds(userIds)
  const walletMap = (wallets || []).reduce((acc, row) => {
    acc[row.user_id] = row
    return acc
  }, {})

  const items = (profiles || []).map((profile) => {
    const wallet = walletMap[profile.user_id]
    return {
      user_id: profile.user_id,
      balance: roundMoney(wallet?.balance || 0),
      total_consumed: roundMoney(wallet?.total_consumed || 0),
      update_time: wallet?.update_time || profile.update_time,
      email: profile.email || '',
      nickname: profile.nickname || '',
      role: profile.role || 'USER',
      status: profile.status || 'ACTIVE',
    }
  })

  return { total: count || 0, items }
}

/**
 * 管理端调整额度并记录操作日志
 * @param {Object} req
 */
async function adjustBalanceFromRequest(req) {
  const amount = Number(req.body.amount)
  const remark = req.body.remark || ''
  const result = await adjustBalanceByAdmin(req.user, req.params.userId, amount, remark)
  await logAdminAction(req, 'adjust_balance', 'user_wallet', req.params.userId)
  return result
}

module.exports = {
  LEDGER_TYPES,
  MIN_AI_BALANCE,
  getRegisterGiftAmount,
  initWalletForNewUser,
  getBalance,
  listLedger,
  ensureSufficientBalance,
  deductForAiCall,
  refundAiCall,
  adjustBalanceByAdmin,
  listWalletsForAdmin,
  adjustBalanceFromRequest,
}
