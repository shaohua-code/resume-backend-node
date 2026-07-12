/**
 * 钱包业务服务
 * 负责余额查询、注册赠送、AI 扣费、管理员额度分配（统一 balance 模型）
 */

const walletRepo = require('../../repositories/wallet.repository')
const userRepo = require('../../repositories/user.repository')
const { ROLES, canManageRole } = require('../../utils/permissions')
const { logAdminAction, getOwnedUserIds, canAccessUser } = require('../admin/admin.common.service')
const { dbAdmin } = require('../../dbClient')

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
  const { data } = await dbAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'register_gift_amount')
    .maybeSingle()
  const amount = data?.config_value?.amount
  return Number(amount ?? 10)
}

/**
 * 从系统配置读取超级管理员初始额度
 * @returns {Promise<number>}
 */
async function getSuperAdminTotalQuota() {
  const { data } = await dbAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'super_admin_total_quota')
    .maybeSingle()
  const amount = data?.config_value?.amount
  return Number(amount ?? 1000000)
}

/**
 * 格式化金额，保留 4 位小数
 * @param {number} value
 */
function roundMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000
}

/**
 * 查询首个超级管理员 user_id
 * @returns {Promise<string|null>}
 */
async function findFirstSuperAdminId() {
  const { data } = await dbAdmin
    .from('user_profile')
    .select('user_id')
    .eq('role', ROLES.SUPER_ADMIN)
    .order('create_time', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.user_id || null
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
 * 确保用户有钱包记录（余额为 0，不触发注册赠送）
 * @param {string} userId
 */
async function ensureWalletRecord(userId) {
  const existing = await getWalletOrNull(userId)
  if (existing) {
    return existing
  }

  const now = new Date().toISOString()
  const { data: wallet, error } = await walletRepo.createWallet({
    user_id: userId,
    balance: 0,
    total_consumed: 0,
    update_time: now,
  })

  if (error) {
    throw Object.assign(new Error(`创建钱包失败：${error.message}`), { statusCode: 500 })
  }

  return wallet
}

/**
 * 确保目标用户有钱包
 * @param {Object} targetProfile
 */
async function ensureTargetWallet(targetProfile) {
  if (targetProfile.role === ROLES.USER) {
    await getBalance(targetProfile.user_id)
    return
  }
  await ensureWalletRecord(targetProfile.user_id)
}

/**
 * 从超级管理员余额扣减注册赠送金额
 * @param {number} amount
 * @returns {Promise<number>} 实际扣减金额
 */
async function deductSuperAdminForRegisterGift(amount) {
  const deductAmount = roundMoney(amount)
  if (deductAmount <= 0) return 0

  const superAdminId = await findFirstSuperAdminId()
  if (!superAdminId) {
    console.warn('[registerGift] 未找到超级管理员，跳过扣减')
    return 0
  }

  await ensureWalletRecord(superAdminId)
  const wallet = await getWalletOrNull(superAdminId)
  const available = roundMoney(wallet?.balance || 0)
  const actualDeduct = roundMoney(Math.min(deductAmount, available))

  if (actualDeduct <= 0) {
    console.warn('[registerGift] 超级管理员余额不足，赠送金额为 0')
    return 0
  }

  await changeBalance({
    userId: superAdminId,
    delta: -actualDeduct,
    type: LEDGER_TYPES.REGISTER_GIFT,
    remark: `新用户注册赠送扣减 ¥${actualDeduct}`,
    paidAmount: 0,
  })

  return actualDeduct
}

/**
 * 新用户注册后初始化钱包并写入注册赠送流水
 * 注册赠送从超级管理员余额扣减
 * @param {string} userId
 */
async function initWalletForNewUser(userId) {
  const existing = await getWalletOrNull(userId)
  if (existing) {
    return existing
  }

  const giftAmount = await getRegisterGiftAmount()
  const now = new Date().toISOString()

  // 先从超管扣减，余额不足则实际赠送为 0
  const actualGift = await deductSuperAdminForRegisterGift(giftAmount)

  const { data: wallet, error: walletError } = await walletRepo.createWallet({
    user_id: userId,
    balance: actualGift,
    total_consumed: 0,
    update_time: now,
  })

  if (walletError) {
    throw Object.assign(new Error(`创建钱包失败：${walletError.message}`), { statusCode: 500 })
  }

  if (actualGift > 0) {
    const superAdminId = await findFirstSuperAdminId()
    const { error: ledgerError } = await walletRepo.insertLedger({
      user_id: userId,
      type: LEDGER_TYPES.REGISTER_GIFT,
      amount: actualGift,
      balance_after: actualGift,
      remark: '新用户注册赠送',
      operator_id: superAdminId,
      paid_amount: 0,
      create_time: now,
    })

    if (ledgerError) {
      throw Object.assign(new Error(`写入注册赠送流水失败：${ledgerError.message}`), { statusCode: 500 })
    }
  }

  return wallet
}

/**
 * 获取用户余额信息（所有角色统一返回 wallet.balance）
 * @param {string} userId
 * @param {string} [role='USER']
 */
async function getBalance(userId, role = ROLES.USER) {
  void role
  let wallet = await getWalletOrNull(userId)
  if (!wallet) {
    wallet = role === ROLES.USER ? await initWalletForNewUser(userId) : await ensureWalletRecord(userId)
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
      paid_amount: roundMoney(row.paid_amount || 0),
      create_time: String(row.create_time),
    })),
  }
}

/**
 * 内部方法：变更余额并写流水
 * @param {Object} options
 */
async function changeBalance({ userId, delta, type, remark, operatorId = null, aiCallId = null, paidAmount = 0 }) {
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
    paid_amount: roundMoney(paidAmount || 0),
    create_time: now,
  })

  if (ledgerError) {
    throw Object.assign(new Error(`写入流水失败：${ledgerError.message}`), { statusCode: 500 })
  }

  return { balance: nextBalance, ledger }
}

/**
 * 上级向下级分配额度：操作方 balance -= N，接收方 balance += N
 * @param {Object} operator
 * @param {Object} target
 * @param {number} amount
 * @param {string} remark
 * @param {number} paidAmount
 */
async function transferBalance(operator, target, amount, remark, paidAmount) {
  const delta = roundMoney(amount)
  const paid = roundMoney(paidAmount)
  if (delta <= 0) {
    throw Object.assign(new Error('分配金额必须为正数'), { statusCode: 400 })
  }

  await ensureWalletRecord(operator.id)
  await ensureTargetWallet(target)

  const operatorWallet = await getWalletOrNull(operator.id)
  const operatorBalance = roundMoney(operatorWallet?.balance || 0)
  if (operatorBalance < delta) {
    throw Object.assign(
      new Error(`可分配额度不足（剩余 ¥${operatorBalance.toFixed(2)}）`),
      { statusCode: 402 },
    )
  }

  const grantRemark = remark || `${operator.role === ROLES.SUPER_ADMIN ? '超级管理员' : '管理员'}分配额度`

  // 扣减操作方余额
  await changeBalance({
    userId: operator.id,
    delta: -delta,
    type: LEDGER_TYPES.ADMIN_GRANT,
    remark: `${grantRemark}（转出至 ${target.nickname || target.user_id}）`,
    operatorId: operator.id,
    paidAmount: 0,
  })

  // 增加接收方余额
  const result = await changeBalance({
    userId: target.user_id,
    delta,
    type: LEDGER_TYPES.ADMIN_GRANT,
    remark: grantRemark,
    operatorId: operator.id,
    paidAmount: paid,
  })

  return {
    user_id: target.user_id,
    balance: result.balance,
    amount: delta,
    paid_amount: paidAmount,
    ledger: result.ledger,
  }
}

/**
 * AI 调用前校验余额是否足够
 * @param {string} userId
 * @param {number} [estimatedCost=MIN_AI_BALANCE]
 * @param {string} [role='USER']
 */
async function ensureSufficientBalance(userId, estimatedCost = MIN_AI_BALANCE, role = ROLES.USER) {
  void role
  const wallet = await getWalletOrNull(userId)
  const balance = roundMoney(wallet?.balance || 0)
  if (balance < estimatedCost) {
    const err = new Error(`账户余额不足（当前 ¥${balance.toFixed(2)}），请先充值或联系管理员`)
    err.code = 'INSUFFICIENT_BALANCE'
    err.statusCode = 402
    throw err
  }
}

/**
 * AI 调用成功后按实际费用扣费（仅扣自身 wallet.balance）
 * @param {string} userId
 * @param {number} cost
 * @param {number} aiCallId
 * @param {string} taskType
 * @param {string} [role='USER']
 */
async function deductForAiCall(userId, cost, aiCallId, taskType, role = ROLES.USER) {
  void role
  const actualCost = roundMoney(cost)
  if (actualCost <= 0) {
    const wallet = await getWalletOrNull(userId)
    return { balance: roundMoney(wallet?.balance || 0), deducted: 0 }
  }

  const result = await changeBalance({
    userId,
    delta: -actualCost,
    type: LEDGER_TYPES.AI_CONSUME,
    remark: `AI 消费：${taskType}`,
    aiCallId,
  })

  return {
    balance: result.balance,
    deducted: actualCost,
  }
}

/**
 * AI 调用失败时回滚已扣费用
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
 * 超级管理员回收额度：目标 balance -= N，超管 balance += N
 * @param {Object} operator
 * @param {Object} target
 * @param {number} amount
 * @param {string} remark
 * @param {number} paidAmount
 */
async function deductBySuperAdmin(operator, target, amount, remark, paidAmount) {
  const deductAmount = roundMoney(amount)
  if (deductAmount <= 0) {
    throw Object.assign(new Error('扣减金额必须为正数'), { statusCode: 400 })
  }

  if (target.role !== ROLES.USER && target.role !== ROLES.ADMIN) {
    throw Object.assign(new Error('仅可扣减普通用户或管理员额度'), { statusCode: 403 })
  }

  await ensureTargetWallet(target)
  await ensureWalletRecord(operator.id)

  const targetWallet = await getWalletOrNull(target.user_id)
  const currentBalance = roundMoney(targetWallet?.balance || 0)
  if (currentBalance < deductAmount) {
    throw Object.assign(
      new Error(`用户余额不足（当前 ¥${currentBalance.toFixed(2)}）`),
      { statusCode: 402 },
    )
  }

  // 扣减目标余额
  const deductResult = await changeBalance({
    userId: target.user_id,
    delta: -deductAmount,
    type: LEDGER_TYPES.ADMIN_DEDUCT,
    remark,
    operatorId: operator.id,
    paidAmount,
  })

  // 退回超管余额
  await changeBalance({
    userId: operator.id,
    delta: deductAmount,
    type: LEDGER_TYPES.ADMIN_DEDUCT,
    remark: `回收额度：${target.nickname || target.user_id}`,
    operatorId: operator.id,
    paidAmount: 0,
  })

  return {
    user_id: target.user_id,
    balance: deductResult.balance,
    amount: -deductAmount,
    paid_amount: paidAmount,
  }
}

/**
 * 管理员调整用户额度（统一 balance 模型）
 * - SUPER_ADMIN 分配：自身 balance -= N，目标 balance += N
 * - SUPER_ADMIN 回收：目标 balance -= N，自身 balance += N
 * - ADMIN 分配：仅正向，自身 balance -= N，归属 USER balance += N
 * @param {Object} operator
 * @param {string} targetUserId
 * @param {number} amount
 * @param {string} remark
 * @param {number} paidAmount
 */
async function adjustBalanceByAdmin(operator, targetUserId, amount, remark = '', paidAmount = 0) {
  const delta = roundMoney(amount)
  if (!delta || Number.isNaN(delta)) {
    throw Object.assign(new Error('调整金额不能为空或 0'), { statusCode: 400 })
  }

  const remarkText = String(remark || '').trim()
  if (!remarkText) {
    throw Object.assign(new Error('备注不能为空'), { statusCode: 400 })
  }

  const paid = roundMoney(paidAmount)
  if (Number.isNaN(paid) || paid < 0) {
    throw Object.assign(new Error('实付金额必填且必须 >= 0'), { statusCode: 400 })
  }

  const { data: target } = await userRepo.findById(targetUserId)
  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
  }

  // 超级管理员回收额度
  if (operator.role === ROLES.SUPER_ADMIN && delta < 0) {
    return deductBySuperAdmin(operator, target, Math.abs(delta), remarkText, paid)
  }

  if (delta <= 0) {
    throw Object.assign(new Error('分配金额必须为正数'), { statusCode: 400 })
  }

  // 普通管理员只能给归属用户分配额度
  if (operator.role === ROLES.ADMIN) {
    if (target.role !== ROLES.USER) {
      throw Object.assign(new Error('管理员仅可为普通用户分配额度'), { statusCode: 403 })
    }
    const hasAccess = await canAccessUser(operator, targetUserId)
    if (!hasAccess) {
      throw Object.assign(new Error('无权操作该用户，仅可操作归属用户'), { statusCode: 403 })
    }
    return transferBalance(operator, target, delta, remarkText, paid)
  }

  // 超级管理员分配
  if (!canManageRole(operator.role, target.role) && operator.id !== target.user_id) {
    throw Object.assign(new Error('无权操作该用户'), { statusCode: 403 })
  }

  return transferBalance(operator, target, delta, remarkText, paid)
}

/**
 * 管理端分页查询用户钱包列表
 * @param {Object} req
 * @param {number} from
 * @param {number} to
 */
async function listWalletsForAdmin(req, from, to) {
  const keyword = (req.query.keyword || '').trim()
  const ownedUserIds = await getOwnedUserIds(req.user)

  const { data: profiles, error, count } = await userRepo.listUsers({
    from,
    to,
    keyword,
    adminRole: req.user.role,
    ownedUserIds,
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
  const paidAmount = Number(req.body.paid_amount)
  const result = await adjustBalanceByAdmin(req.user, req.params.userId, amount, remark, paidAmount)
  await logAdminAction(req, 'adjust_balance', 'user_wallet', req.params.userId)
  return result
}

/**
 * 获取当前管理员额度摘要（我的可用额度 + 实付合计）
 * @param {Object} req
 */
async function getWalletSummary(req) {
  const balanceInfo = await getBalance(req.user.id, req.user.role)
  const ownedUserIds = await getOwnedUserIds(req.user)
  const totalPaidAmount = await walletRepo.sumPaidAmount({
    operatorId: req.user.id,
    userIds: ownedUserIds,
  })
  return {
    my_balance: balanceInfo.balance,
    total_paid_amount: roundMoney(totalPaidAmount),
  }
}

module.exports = {
  LEDGER_TYPES,
  MIN_AI_BALANCE,
  getRegisterGiftAmount,
  getSuperAdminTotalQuota,
  findFirstSuperAdminId,
  initWalletForNewUser,
  getBalance,
  listLedger,
  ensureSufficientBalance,
  deductForAiCall,
  refundAiCall,
  adjustBalanceByAdmin,
  listWalletsForAdmin,
  adjustBalanceFromRequest,
  getWalletSummary,
  transferBalance,
}
