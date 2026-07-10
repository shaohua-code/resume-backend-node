/**
 * 钱包业务服务
 * 负责余额查询、注册赠送、AI 扣费、管理员额度池分配
 */

const walletRepo = require('../../repositories/wallet.repository')
const userRepo = require('../../repositories/user.repository')
const { ROLES, PERMISSIONS, hasPermission, canManageRole } = require('../../utils/permissions')
const { logAdminAction, getOwnedUserIds, canAccessUser } = require('../admin/admin.common.service')
const { supabaseAdmin } = require('../../supabaseClient')

// 流水类型枚举
const LEDGER_TYPES = {
  REGISTER_GIFT: 'REGISTER_GIFT',
  ADMIN_GRANT: 'ADMIN_GRANT',
  ADMIN_DEDUCT: 'ADMIN_DEDUCT',
  ADMIN_TRANSFER_OUT: 'ADMIN_TRANSFER_OUT',
  AI_CONSUME: 'AI_CONSUME',
  REFUND: 'REFUND',
  // 新增：额度池分配相关
  ADMIN_ALLOCATE: 'ADMIN_ALLOCATE',       // 管理员从额度池分配额度给用户
  ADMIN_POOL_GRANT: 'ADMIN_POOL_GRANT',   // 超管给管理员分配额度池
}

// AI 调用前最低余额门槛（元）
const MIN_AI_BALANCE = 0.01

/**
 * 从系统配置读取新用户注册赠送金额
 * @returns {Promise<number>}
 */
async function getRegisterGiftAmount() {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'register_gift_amount')
    .maybeSingle()
  const amount = data?.config_value?.amount
  return Number(amount ?? 10)
}

/**
 * 从系统配置读取超级管理员初始总额度池
 * @returns {Promise<number>}
 */
async function getSuperAdminTotalQuota() {
  const { data } = await supabaseAdmin
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
 * 查询或创建管理员额度池记录
 * 超级管理员首次访问时自动初始化总额度池
 * @param {string} adminId
 * @param {string} role
 */
async function ensureQuotaPool(adminId, role) {
  const { data: existing } = await walletRepo.findQuotaPool(adminId)
  if (existing) {
    return existing
  }
  // 超级管理员首次初始化总额度池
  if (role === ROLES.SUPER_ADMIN) {
    const totalQuota = await getSuperAdminTotalQuota()
    const now = new Date().toISOString()
    const { data, error } = await walletRepo.createQuotaPool({
      admin_id: adminId,
      total_quota: totalQuota,
      allocated_quota: 0,
      update_time: now,
    })
    if (error) {
      throw Object.assign(new Error(`初始化额度池失败：${error.message}`), { statusCode: 500 })
    }
    return data
  }
  // 普通管理员无额度池记录时返回空记录（需超管分配）
  return { admin_id: adminId, total_quota: 0, allocated_quota: 0, update_time: null }
}

/**
 * 获取管理员额度池可分配余额
 * @param {string} adminId
 * @param {string} role
 * @returns {Promise<Object>} { total_quota, allocated_quota, available }
 */
async function getQuotaPool(adminId, role) {
  const pool = await ensureQuotaPool(adminId, role)
  const total = roundMoney(pool.total_quota)
  const allocated = roundMoney(pool.allocated_quota)
  return {
    total_quota: total,
    allocated_quota: allocated,
    available: roundMoney(total - allocated),
  }
}

/**
 * 获取可用于 AI 消费的余额
 * 普通用户：钱包余额；管理员/超管：钱包余额 + 额度池剩余可分配
 * @param {string} userId
 * @param {string} [role='USER']
 */
async function getAiSpendableBalance(userId, role = ROLES.USER) {
  let wallet = await getWalletOrNull(userId)
  if (!wallet && role === ROLES.USER) {
    wallet = await initWalletForNewUser(userId)
  }
  const walletBalance = roundMoney(wallet?.balance || 0)

  if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
    const pool = await getQuotaPool(userId, role)
    return roundMoney(walletBalance + pool.available)
  }
  return walletBalance
}

/**
 * 新用户注册后初始化钱包并写入注册赠送流水
 * 注册赠送金额从超级管理员总额度池扣减
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
    paid_amount: 0,
    create_time: now,
  })

  if (ledgerError) {
    throw Object.assign(new Error(`写入注册赠送流水失败：${ledgerError.message}`), { statusCode: 500 })
  }

  // 从超级管理员总额度池扣减注册赠送金额
  await deductSuperAdminQuotaPool(giftAmount)

  return wallet
}

/**
 * 从超级管理员总额度池扣减金额（注册赠送等场景）
 * @param {number} amount
 */
async function deductSuperAdminQuotaPool(amount) {
  const deductAmount = roundMoney(amount)
  if (deductAmount <= 0) return

  // 找到首个超级管理员的额度池
  const { data: superAdmin } = await supabaseAdmin
    .from('user_profile')
    .select('user_id')
    .eq('role', 'SUPER_ADMIN')
    .order('create_time', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!superAdmin) return

  const pool = await ensureQuotaPool(superAdmin.user_id, ROLES.SUPER_ADMIN)
  const newAllocated = roundMoney(Number(pool.allocated_quota || 0) + deductAmount)
  await walletRepo.updateQuotaPool(superAdmin.user_id, {
    allocated_quota: newAllocated,
    update_time: new Date().toISOString(),
  })
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
 * 获取用户余额信息
 * 普通用户返回钱包余额；管理员/超管返回额度池剩余可分配额度
 * @param {string} userId
 * @param {string} [role='USER']
 */
async function getBalance(userId, role = ROLES.USER) {
  // 管理员：账户余额 = 钱包余额 + 额度池剩余（与 AI 扣费校验一致）
  if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
    const pool = await getQuotaPool(userId, role)
    let wallet = await getWalletOrNull(userId)
    if (!wallet) {
      wallet = await ensureWalletRecord(userId)
    }
    const walletBalance = roundMoney(wallet.balance)
    const spendable = roundMoney(walletBalance + pool.available)
    return {
      balance: spendable,
      total_consumed: roundMoney(wallet.total_consumed),
      update_time: wallet.update_time || pool.update_time,
      quota_mode: true,
      total_quota: pool.total_quota,
      allocated_quota: pool.allocated_quota,
      available_quota: pool.available,
      wallet_balance: walletBalance,
    }
  }

  let wallet = await getWalletOrNull(userId)
  if (!wallet) {
    wallet = await initWalletForNewUser(userId)
  }
  return {
    balance: roundMoney(wallet.balance),
    total_consumed: roundMoney(wallet.total_consumed),
    update_time: wallet.update_time,
    quota_mode: false,
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
 * AI 调用前校验余额是否足够
 * @param {string} userId
 * @param {number} [estimatedCost=MIN_AI_BALANCE]
 * @param {string} [role='USER']
 */
async function ensureSufficientBalance(userId, estimatedCost = MIN_AI_BALANCE, role = ROLES.USER) {
  const balance = await getAiSpendableBalance(userId, role)
  if (balance < estimatedCost) {
    const err = new Error(`账户余额不足（当前 ¥${balance.toFixed(2)}），请先充值或联系管理员`)
    err.code = 'INSUFFICIENT_BALANCE'
    err.statusCode = 402
    throw err
  }
}

/**
 * 从额度池扣减 AI 消费（管理员钱包不足时）
 * @param {string} userId
 * @param {string} role
 * @param {number} amount
 * @param {number} aiCallId
 * @param {string} taskType
 */
async function deductFromQuotaPoolForAi(userId, role, amount, aiCallId, taskType) {
  const deductAmount = roundMoney(amount)
  const pool = await getQuotaPool(userId, role)
  if (pool.available < deductAmount) {
    const err = new Error('账户余额不足，请先充值或联系管理员')
    err.code = 'INSUFFICIENT_BALANCE'
    err.statusCode = 402
    throw err
  }

  await walletRepo.updateQuotaPool(userId, {
    allocated_quota: roundMoney(pool.allocated_quota + deductAmount),
    update_time: new Date().toISOString(),
  })

  // 写入流水（不改变钱包余额）
  await ensureWalletRecord(userId)
  const wallet = await getWalletOrNull(userId)
  const walletBalance = roundMoney(wallet?.balance || 0)
  await walletRepo.insertLedger({
    user_id: userId,
    type: LEDGER_TYPES.AI_CONSUME,
    amount: -deductAmount,
    balance_after: walletBalance,
    remark: `AI 消费（额度池）：${taskType}`,
    ai_call_id: aiCallId,
    paid_amount: 0,
    create_time: new Date().toISOString(),
  })
}

/**
 * AI 调用成功后按实际费用扣费
 * @param {string} userId
 * @param {number} cost
 * @param {number} aiCallId
 * @param {string} taskType
 * @param {string} [role='USER']
 */
async function deductForAiCall(userId, cost, aiCallId, taskType, role = ROLES.USER) {
  const actualCost = roundMoney(cost)
  if (actualCost <= 0) {
    return { balance: await getAiSpendableBalance(userId, role), deducted: 0 }
  }

  let remaining = actualCost
  const wallet = await getWalletOrNull(userId)

  // 优先扣钱包余额
  const walletBalance = roundMoney(wallet?.balance || 0)
  if (walletBalance > 0 && remaining > 0) {
    const fromWallet = Math.min(walletBalance, remaining)
    await changeBalance({
      userId,
      delta: -fromWallet,
      type: LEDGER_TYPES.AI_CONSUME,
      remark: `AI 消费：${taskType}`,
      aiCallId,
    })
    remaining = roundMoney(remaining - fromWallet)
  }

  // 管理员钱包不足时，从额度池扣减
  if (remaining > 0) {
    if (role !== ROLES.ADMIN && role !== ROLES.SUPER_ADMIN) {
      const err = new Error('账户余额不足，请先充值或联系管理员')
      err.code = 'INSUFFICIENT_BALANCE'
      err.statusCode = 402
      throw err
    }
    await deductFromQuotaPoolForAi(userId, role, remaining, aiCallId, taskType)
  }

  return {
    balance: await getAiSpendableBalance(userId, role),
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
 * 将额度退回超级管理员额度池（减少 allocated_quota，可用额度增加）
 * @param {string} superAdminId
 * @param {number} amount
 */
async function releaseSuperAdminQuota(superAdminId, amount) {
  const releaseAmount = roundMoney(amount)
  if (releaseAmount <= 0) return
  const superPool = await getQuotaPool(superAdminId, ROLES.SUPER_ADMIN)
  await walletRepo.updateQuotaPool(superAdminId, {
    allocated_quota: roundMoney(Math.max(0, superPool.allocated_quota - releaseAmount)),
    update_time: new Date().toISOString(),
  })
}

/**
 * 记录管理员额度池流水（不改变 user_wallet 余额）
 */
async function recordAdminPoolLedger(userId, delta, type, remark, operatorId, paidAmount) {
  await ensureWalletRecord(userId)
  const beforeWallet = await getWalletOrNull(userId)
  const beforeBalance = beforeWallet ? Number(beforeWallet.balance) : 0
  await changeBalance({
    userId,
    delta,
    type,
    remark,
    operatorId,
    paidAmount,
  })
  await walletRepo.updateWallet(userId, {
    balance: roundMoney(beforeBalance),
    update_time: new Date().toISOString(),
  })
}

/**
 * 超级管理员扣减用户或管理员额度，并退回自身额度池
 */
async function deductBySuperAdmin(operator, target, amount, remark, paidAmount) {
  const deductAmount = roundMoney(amount)
  if (deductAmount <= 0) {
    throw Object.assign(new Error('扣减金额必须为正数'), { statusCode: 400 })
  }

  // 扣减普通用户余额
  if (target.role === ROLES.USER) {
    await ensureTargetWallet(target)
    const wallet = await getWalletOrNull(target.user_id)
    const currentBalance = roundMoney(wallet?.balance || 0)
    if (currentBalance < deductAmount) {
      throw Object.assign(new Error(`用户余额不足（当前 ¥${currentBalance.toFixed(2)}）`), { statusCode: 402 })
    }

    const result = await changeBalance({
      userId: target.user_id,
      delta: -deductAmount,
      type: LEDGER_TYPES.ADMIN_DEDUCT,
      remark,
      operatorId: operator.id,
      paidAmount,
    })

    // 扣减用户额度后，退回超管可分配额度池
    await releaseSuperAdminQuota(operator.id, deductAmount)

    return {
      user_id: target.user_id,
      balance: result.balance,
      amount: -deductAmount,
      paid_amount: paidAmount,
    }
  }

  // 扣减管理员额度池（仅可回收未分配给其用户的部分）
  if (target.role === ROLES.ADMIN) {
    const targetPool = await ensureQuotaPool(target.user_id, target.role)
    const poolTotal = roundMoney(targetPool.total_quota || 0)
    const poolAllocated = roundMoney(targetPool.allocated_quota || 0)
    const reclaimable = roundMoney(poolTotal - poolAllocated)
    if (deductAmount > reclaimable) {
      throw Object.assign(
        new Error(`管理员额度池可扣减不足（最多 ¥${reclaimable.toFixed(2)}）`),
        { statusCode: 402 },
      )
    }

    const newTotal = roundMoney(poolTotal - deductAmount)
    await walletRepo.updateQuotaPool(target.user_id, {
      total_quota: newTotal,
      update_time: new Date().toISOString(),
    })

    await recordAdminPoolLedger(
      target.user_id,
      -deductAmount,
      LEDGER_TYPES.ADMIN_DEDUCT,
      remark,
      operator.id,
      paidAmount,
    )

    // 退回超管额度池
    await releaseSuperAdminQuota(operator.id, deductAmount)

    return {
      user_id: target.user_id,
      total_quota: newTotal,
      amount: -deductAmount,
      paid_amount: paidAmount,
    }
  }

  throw Object.assign(new Error('仅可扣减普通用户或管理员额度'), { statusCode: 403 })
}

/**
 * 管理员调整用户额度（额度池分配体系）
 * - 超级管理员给管理员分配额度池：ADMIN_POOL_GRANT
 * - 超级管理员给用户分配额度：ADMIN_GRANT（从总额度池扣减）
 * - 超级管理员扣减用户/管理员额度：ADMIN_DEDUCT（退回超管额度池）
 * - 普通管理员给归属用户分配额度：ADMIN_ALLOCATE（从自身额度池扣减）
 * @param {Object} operator - 操作者 req.user
 * @param {string} targetUserId
 * @param {number} amount - 正数增加，负数扣减（仅超管）
 * @param {string} remark - 备注（必填）
 * @param {number} paidAmount - 实付金额（必填，>=0）
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

  // 超级管理员扣减额度
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
    return allocateFromAdminPool(operator, target, delta, remarkText, paid)
  }

  // 超级管理员
  if (!canManageRole(operator.role, target.role) && operator.id !== target.user_id) {
    throw Object.assign(new Error('无权操作该用户'), { statusCode: 403 })
  }

  // 场景 A：超管给管理员分配额度池
  if (target.role === ROLES.ADMIN) {
    return grantAdminPoolFromSuperAdmin(operator, target, delta, remarkText, paid)
  }

  // 场景 B：超管给用户分配额度
  await ensureTargetWallet(target)
  const superPool = await getQuotaPool(operator.id, operator.role)
  if (superPool.available < delta) {
    throw Object.assign(new Error(`可分配额度不足（剩余 ¥${superPool.available.toFixed(2)}）`), { statusCode: 402 })
  }

  // 扣减超管总额度池
  await walletRepo.updateQuotaPool(operator.id, {
    allocated_quota: roundMoney(superPool.allocated_quota + delta),
    update_time: new Date().toISOString(),
  })

  // 增加用户余额
  const result = await changeBalance({
    userId: targetUserId,
    delta,
    type: LEDGER_TYPES.ADMIN_GRANT,
    remark: remarkText || '超级管理员分配额度',
    operatorId: operator.id,
    paidAmount: paid,
  })

  return {
    user_id: targetUserId,
    balance: result.balance,
    amount: delta,
    paid_amount: paid,
  }
}

/**
 * 超级管理员给管理员分配额度池
 * @param {Object} operator - 超管
 * @param {Object} target - 目标管理员
 * @param {number} amount
 * @param {string} remark
 * @param {number} paidAmount
 */
async function grantAdminPoolFromSuperAdmin(operator, target, amount, remark, paidAmount) {
  console.log('[grantAdminPool] 开始分配', { operatorId: operator.id, targetId: target.user_id, amount, targetRole: target.role })
  const superPool = await getQuotaPool(operator.id, operator.role)
  console.log('[grantAdminPool] 超管额度池', superPool)
  if (superPool.available < amount) {
    throw Object.assign(new Error(`可分配额度不足（剩余 ¥${superPool.available.toFixed(2)}）`), { statusCode: 402 })
  }

  // 扣减超管总额度池
  const updateResult = await walletRepo.updateQuotaPool(operator.id, {
    allocated_quota: roundMoney(superPool.allocated_quota + amount),
    update_time: new Date().toISOString(),
  })
  console.log('[grantAdminPool] 扣减超管额度池结果', { affected: !!updateResult.data, error: updateResult.error })

  // 增加目标管理员的额度池（有则更新，无则创建）
  const targetPool = await ensureQuotaPool(target.user_id, target.role)
  console.log('[grantAdminPool] 目标管理员额度池查询结果', { hasRecord: !!targetPool.id, pool: targetPool })
  const newTotal = roundMoney(Number(targetPool.total_quota || 0) + amount)
  const now = new Date().toISOString()

  if (targetPool.id) {
    // 已有记录 → 更新
    const upResult = await walletRepo.updateQuotaPool(target.user_id, {
      total_quota: newTotal,
      update_time: now,
    })
    console.log('[grantAdminPool] 更新目标额度池结果', { affected: !!upResult.data, error: upResult.error })
  } else {
    // 无记录 → 尝试创建，若唯一键冲突（并发/残留数据）则回退为更新
    const crResult = await walletRepo.createQuotaPool({
      admin_id: target.user_id,
      total_quota: newTotal,
      allocated_quota: 0,
      update_time: now,
    })
    console.log('[grantAdminPool] 创建目标额度池结果', { data: crResult.data, error: crResult.error })
    if (crResult.error && crResult.error.code === '23505') {
      // 唯一约束冲突：记录已被其他请求创建，改为更新
      console.log('[grantAdminPool] 唯一键冲突，切换为更新')
      const fallbackResult = await walletRepo.updateQuotaPool(target.user_id, {
        total_quota: newTotal,
        update_time: now,
      })
      console.log('[grantAdminPool] 回退更新结果', { affected: !!fallbackResult.data, error: fallbackResult.error })
    } else if (crResult.error) {
      throw Object.assign(new Error(`创建管理员额度池失败：${crResult.error.message}`), { statusCode: 500 })
    }
  }

  // 写流水到目标管理员（balance_ledger，type=ADMIN_POOL_GRANT）
  // 注意：delta 记录实际分配金额（用于消费记录展示），但不影响 user_wallet 余额
  await ensureWalletRecord(target.user_id)
  // 记录 changeBalance 前的原始余额（用于后续回退）
  const beforeWallet = await getWalletOrNull(target.user_id)
  const beforeBalance = beforeWallet ? Number(beforeWallet.balance) : 0
  await changeBalance({
    userId: target.user_id,
    delta: amount, // 记录实际分配金额，消费记录可正确展示
    type: LEDGER_TYPES.ADMIN_POOL_GRANT,
    remark: remark || `超级管理员分配额度池 ${amount}`,
    operatorId: operator.id,
    paidAmount,
  })

  // 额度池分配不改变 user_wallet 余额，回退到 changeBalance 之前的值
  await walletRepo.updateWallet(target.user_id, {
    balance: roundMoney(beforeBalance),
    update_time: new Date().toISOString(),
  })

  console.log('[grantAdminPool] 分配完成', { targetUserId: target.user_id, newTotal })
  return {
    user_id: target.user_id,
    total_quota: newTotal,
    amount,
    paid_amount: paidAmount,
  }
}

/**
 * 普通管理员从自身额度池给归属用户分配额度
 * @param {Object} operator - 普通管理员
 * @param {Object} target - 目标用户
 * @param {number} amount
 * @param {string} remark
 * @param {number} paidAmount
 */
async function allocateFromAdminPool(operator, target, amount, remark, paidAmount) {
  const adminPool = await getQuotaPool(operator.id, operator.role)
  if (adminPool.available < amount) {
    throw Object.assign(new Error(`可分配额度不足（剩余 ¥${adminPool.available.toFixed(2)}）`), { statusCode: 402 })
  }

  // 扣减管理员额度池
  await walletRepo.updateQuotaPool(operator.id, {
    allocated_quota: roundMoney(adminPool.allocated_quota + amount),
    update_time: new Date().toISOString(),
  })

  // 增加用户余额
  await ensureTargetWallet(target)
  const result = await changeBalance({
    userId: target.user_id,
    delta: amount,
    type: LEDGER_TYPES.ADMIN_ALLOCATE,
    remark: remark || '管理员分配额度',
    operatorId: operator.id,
    paidAmount,
  })

  return {
    user_id: target.user_id,
    balance: result.balance,
    amount,
    paid_amount: paidAmount,
  }
}

/**
 * 管理端分页查询用户钱包列表
 * 普通管理员仅返回归属用户钱包
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

  // 对 ADMIN 角色的用户，额外查询其 admin_quota_pool 额度池
  const adminUserIds = (profiles || [])
    .filter((p) => p.role === ROLES.ADMIN)
    .map((p) => p.user_id)
  let quotaPoolMap = {}
  if (adminUserIds.length > 0) {
    const { data: pools } = await supabaseAdmin
      .from('admin_quota_pool')
      .select('*')
      .in('admin_id', adminUserIds)
    quotaPoolMap = (pools || []).reduce((acc, row) => {
      acc[row.admin_id] = row
      return acc
    }, {})
  }

  const items = (profiles || []).map((profile) => {
    const wallet = walletMap[profile.user_id]
    const pool = quotaPoolMap[profile.user_id]
    return {
      user_id: profile.user_id,
      // 管理员显示额度池总额度，普通用户显示钱包余额
      balance: pool ? roundMoney(pool.total_quota) : roundMoney(wallet?.balance || 0),
      total_consumed: roundMoney(wallet?.total_consumed || 0),
      // 额度池已分配（仅管理员有值）
      allocated_quota: pool ? roundMoney(pool.allocated_quota) : null,
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
 * 获取管理员额度池摘要信息（含实付金额合计）
 * @param {Object} req
 */
async function getQuotaPoolSummary(req) {
  const pool = await getQuotaPool(req.user.id, req.user.role)
  const ownedUserIds = await getOwnedUserIds(req.user)
  // 实付金额合计：超管看所有，普通管理员看归属用户范围
  const totalPaidAmount = await walletRepo.sumPaidAmount({
    operatorId: req.user.id,
    userIds: ownedUserIds,
  })
  return {
    total_quota: pool.total_quota,
    allocated_quota: pool.allocated_quota,
    available: pool.available,
    total_paid_amount: roundMoney(totalPaidAmount),
  }
}

module.exports = {
  LEDGER_TYPES,
  MIN_AI_BALANCE,
  getRegisterGiftAmount,
  getSuperAdminTotalQuota,
  initWalletForNewUser,
  getBalance,
  listLedger,
  ensureSufficientBalance,
  deductForAiCall,
  refundAiCall,
  adjustBalanceByAdmin,
  listWalletsForAdmin,
  adjustBalanceFromRequest,
  getQuotaPool,
  getQuotaPoolSummary,
}
