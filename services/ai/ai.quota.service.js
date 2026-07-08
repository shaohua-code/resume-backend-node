/**
 * AI 配额审计服务
 * 负责每日调用次数限制校验和调用记录持久化
 */

const { supabaseAdmin } = require('../../supabaseClient');
const { hasPermission, isAdminRole } = require('../../utils/permissions');
const { PERMISSIONS } = require('../../utils/permissions');

/**
 * 从 system_config 读取 AI 每日调用上限
 * @param {string} role 用户角色
 * @returns {Promise<number>} -1 表示无限制
 */
async function getAiDailyLimit(role) {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'ai_daily_limit')
    .single();
  const limitMap = (data && data.config_value) || { USER: 3, VIP: -1 };
  return Number(Object.prototype.hasOwnProperty.call(limitMap, role) ? limitMap[role] : 3);
}

/**
 * 校验用户当日是否还有指定任务的 AI 调用配额
 * @param {object} req Express 请求对象，需挂载 req.user
 * @param {string} taskType AI 任务类型
 */
async function ensureAiQuota(req, taskType) {
  if (isAdminRole(req.user.role) || hasPermission(req.user.role, PERMISSIONS.VIP_AI_UNLIMITED)) {
    return;
  }
  const limit = await getAiDailyLimit(req.user.role);
  if (limit < 0) {
    return;
  }
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from('ai_call_record')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('task_type', taskType)
    .gte('create_time', dayStart.toISOString());
  if ((count || 0) >= limit) {
    const err = new Error(`今日${taskType}次数已用完，请升级 VIP 解锁不限次数`);
    err.code = 'AI_LIMIT_EXCEEDED';
    throw err;
  }
}

/**
 * 记录一次 AI 调用
 * @param {object} req Express 请求对象
 * @param {string} taskType AI 任务类型
 * @param {string} model 使用的模型
 * @param {boolean} success 是否成功
 * @param {string} errorMessage 错误信息
 * @param {object} meta 元信息 { usage, cost }
 */
async function recordAiCall(req, taskType, model, success, errorMessage = '', meta = null) {
  const usage = meta?.usage || {};
  const { error } = await supabaseAdmin.from('ai_call_record').insert({
    user_id: req.user.id,
    task_type: taskType,
    model: meta?.model || model || '',
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    cost: meta?.cost || 0,
    success,
    error_message: errorMessage,
    create_time: new Date().toISOString(),
  });
  if (error) {
    console.error('[recordAiCall]', error.message, { taskType, meta });
  }
}

module.exports = {
  getAiDailyLimit,
  ensureAiQuota,
  recordAiCall,
};
