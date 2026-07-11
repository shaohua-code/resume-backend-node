/**
 * AI 余额计费服务
 * 负责调用前余额校验、调用记录持久化与成功后扣费
 */

const { dbAdmin } = require('../../dbClient')
const walletService = require('../wallet/wallet.service')

/**
 * 调用前校验用户余额是否足够
 * @param {object} req Express 请求对象
 * @param {string} taskType AI 任务类型
 * @param {number} [estimatedCost] 预估费用
 */
async function ensureAiQuota(req, taskType, estimatedCost) {
  await walletService.ensureSufficientBalance(
    req.user.id,
    estimatedCost || walletService.MIN_AI_BALANCE,
    req.user.role,
  )
}

/**
 * 记录一次 AI 调用，成功时按实际费用扣费
 * @param {object} req Express 请求对象
 * @param {string} taskType AI 任务类型
 * @param {string} model 使用的模型
 * @param {boolean} success 是否成功
 * @param {string} errorMessage 错误信息
 * @param {object} meta 元信息 { usage, cost, model }
 */
async function recordAiCall(req, taskType, model, success, errorMessage = '', meta = null) {
  const usage = meta?.usage || {}
  const cost = meta?.cost || 0

  const { data: callRecord, error } = await dbAdmin
    .from('ai_call_record')
    .insert({
      user_id: req.user.id,
      task_type: taskType,
      model: meta?.model || model || '',
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      cost,
      success,
      error_message: errorMessage,
      create_time: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    console.error('[recordAiCall]', error.message, { taskType, meta })
    return
  }

  // 仅成功调用且费用大于 0 时扣减余额
  if (success && cost > 0 && callRecord?.id) {
    try {
      await walletService.deductForAiCall(req.user.id, cost, callRecord.id, taskType, req.user.role)
    } catch (deductErr) {
      console.error('[recordAiCall] deduct failed:', deductErr.message, { taskType, cost })
    }
  }
}

module.exports = {
  ensureAiQuota,
  recordAiCall,
}
