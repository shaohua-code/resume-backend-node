/**
 * AI 调用费用计算
 * 根据 ai_model 表配置的每百万 token 单价，计算单次调用费用（CNY）
 */

const { supabaseAdmin } = require('../supabaseClient');

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

/**
 * 按 model_key 查询 ai_model 表单价并计算费用
 * @param {string} modelKey 模型 key（与后台 AI模型管理 model_key 一致）
 * @param {object} usage token 用量
 * @returns {Promise<number>} 费用（元），未配置单价时返回 0
 */
async function calcAiCost(modelKey, usage = {}) {
  const normalized = normalizeUsage(usage);
  if (!modelKey || (!normalized.prompt_tokens && !normalized.completion_tokens)) {
    return 0;
  }

  const { data } = await supabaseAdmin
    .from('ai_model')
    .select('input_price_per_million, output_price_per_million')
    .eq('model_key', modelKey)
    .maybeSingle();

  const inputPrice = Number(data?.input_price_per_million) || 0;
  const outputPrice = Number(data?.output_price_per_million) || 0;
  if (!inputPrice && !outputPrice) {
    return 0;
  }

  const cost =
    (normalized.prompt_tokens / 1e6) * inputPrice +
    (normalized.completion_tokens / 1e6) * outputPrice;

  return Math.round(cost * 1e6) / 1e6;
}

module.exports = {
  normalizeUsage,
  calcAiCost,
};
