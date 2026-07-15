/**
 * AI 调用费用计算
 * 根据 ai_model 表配置的每百万 token 单价，计算单次调用费用（CNY）
 */

const { dbAdmin } = require('../dbClient');

function normalizeUsage(usage = {}) {
  // 同时兼容 OpenAI/DeepSeek 的 prompt_tokens 与 DashScope 的 input_tokens 命名。
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  const cachedInputTokens = Math.min(
    promptTokens,
    Number(
      usage.prompt_cache_hit_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens,
    ) || 0,
  );
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
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

  let { data, error } = await dbAdmin
    .from('ai_model')
    .select('input_price_per_million, cached_input_price_per_million, output_price_per_million')
    .eq('model_key', modelKey)
    .maybeSingle();

  // 数据库迁移尚未执行时仍按旧字段计费，保证平滑发布。
  if (error) {
    const legacyResult = await dbAdmin
      .from('ai_model')
      .select('input_price_per_million, output_price_per_million')
      .eq('model_key', modelKey)
      .maybeSingle();
    data = legacyResult.data;
  }

  const inputPrice = Number(data?.input_price_per_million) || 0;
  // null/undefined 表示沿用普通输入价；显式配置 0 则表示缓存输入免费。
  const cachedInputPrice = data?.cached_input_price_per_million == null
    ? inputPrice
    : Number(data.cached_input_price_per_million) || 0;
  const outputPrice = Number(data?.output_price_per_million) || 0;
  if (!inputPrice && !outputPrice) {
    return 0;
  }

  const uncachedInputTokens = Math.max(0, normalized.prompt_tokens - normalized.cached_input_tokens);
  const cost =
    (uncachedInputTokens / 1e6) * inputPrice +
    (normalized.cached_input_tokens / 1e6) * cachedInputPrice +
    (normalized.completion_tokens / 1e6) * outputPrice;

  return Math.round(cost * 1e6) / 1e6;
}

module.exports = {
  normalizeUsage,
  calcAiCost,
};
