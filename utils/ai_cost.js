/**
 * AI 调用费用计算
 * 根据 ai_model 表配置的每百万 token 单价，计算单次调用费用（CNY）
 */

const { supabaseAdmin } = require('../supabaseClient');

// 内置默认定价（元/百万 token），ai_model 表查不到时使用
const DEFAULT_MODEL_PRICING = {
  'deepseek-v4-flash': { input: 0.5, output: 2.0 },
  'deepseek-chat': { input: 2.0, output: 8.0 },
};

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
 * 按 model_key 查询单价并计算费用
 * @param {string} modelKey 实际使用的模型 key
 * @param {object} usage token 用量
 * @returns {Promise<number>} 费用（元），保留 6 位小数精度
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

  let inputPrice = Number(data?.input_price_per_million) || 0;
  let outputPrice = Number(data?.output_price_per_million) || 0;
  // 表中无单价时回退到内置默认定价，避免费用恒为 0
  if (!inputPrice && !outputPrice) {
    const fallback = DEFAULT_MODEL_PRICING[modelKey];
    if (fallback) {
      inputPrice = fallback.input;
      outputPrice = fallback.output;
    } else {
      return 0;
    }
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
