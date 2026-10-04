/**
 * AI 简历到 IAM 模型用量服务的服务端适配。
 * 仅上报身份关联与 Token 计数，不把 Prompt、模型响应或供应商凭证发往 IAM。
 */
const axios = require('axios')
const crypto = require('crypto')
const { settings } = require('../../config')

const MAX_TOKENS = 10_000_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 中文/ASCII 混合文本按 UTF-8 字节粗估；正式账本优先使用 Provider 返回的实测值。 */
function estimateTextTokens(value) {
  const text = String(value || '')
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 3) : 0
}

/** 为视觉输入预留保守的近似 Token；结算时再以 Provider 用量覆盖该估算。 */
function estimateImageTokens(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0
  return Math.min(MAX_TOKENS, Math.max(1024, Math.ceil(byteLength / 128)))
}

/** 生成不泄露上游详情的 IAM 用量错误；调用层可据 IAM_ 前缀禁止切模型重试。 */
function createUsageError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

/** 校验本次授权返回的主体上下文，绝不回退到浏览器或业务库提供的租户/应用 ID。 */
function assertTrustedContext(context) {
  if (!context || !UUID_PATTERN.test(String(context.tenantId || ''))
      || !UUID_PATTERN.test(String(context.subject || ''))
      || !UUID_PATTERN.test(String(context.applicationId || ''))
      || !UUID_PATTERN.test(String(context.modelId || ''))) {
    throw createUsageError(503, 'IAM_MODEL_USAGE_CONTEXT_INVALID', 'IAM 模型用量主体上下文无效')
  }
}

/** 调用 IAM 内部端点；共享密钥仅从 AI 简历后端运行环境读取。 */
async function postUsage(path, payload, gatewayKey) {
  return axios.post(`${String(settings.IAM_ISSUER || '').replace(/\/+$/, '')}/api/v1/internal/model-usage${path}`, payload, {
    timeout: 10000,
    maxRedirects: 0,
    headers: {
      'X-IAM-Model-Gateway-Key': gatewayKey,
      'Content-Type': 'application/json',
    },
  })
}

/** 请求前预留租户模型额度；IAM 未配置网关密钥时保留既有计费路径。 */
async function reserveIamModelUsage(context, prompt, maxOutputTokens, imageByteLength = 0) {
  if (!context) return null
  const gatewayKey = String(settings.IAM_MODEL_USAGE_API_KEY || '')
  if (!gatewayKey) return null
  if (Buffer.byteLength(gatewayKey, 'utf8') < 32) {
    throw createUsageError(503, 'IAM_MODEL_USAGE_CONFIGURATION_INVALID', 'IAM 模型用量密钥配置不安全')
  }
  assertTrustedContext(context)

  const outputTokens = Number(maxOutputTokens)
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > MAX_TOKENS) {
    throw createUsageError(503, 'IAM_MODEL_USAGE_CONFIGURATION_INVALID', '模型最大输出 Token 配置无效')
  }
  const requestId = crypto.randomUUID()
  const estimatedInputTokens = Math.min(
    MAX_TOKENS,
    estimateTextTokens(prompt) + estimateImageTokens(imageByteLength),
  )
  let result
  try {
    ({ data: result } = await postUsage('/reservations', {
      request_id: requestId,
      tenant_id: context.tenantId,
      model_id: context.modelId,
      application_id: context.applicationId,
      user_id: context.subject,
      reserved_input_tokens: estimatedInputTokens,
      reserved_output_tokens: outputTokens,
    }, gatewayKey))
  } catch (error) {
    if (error?.response?.status === 429) {
      throw createUsageError(429, 'IAM_MODEL_QUOTA_EXCEEDED', '当前模型已达到租户调用限额')
    }
    throw createUsageError(503, 'IAM_MODEL_USAGE_UNAVAILABLE', 'IAM 模型额度服务暂不可用')
  }

  if (!result || result.allowed !== true || result.already_settled === true
      || typeof result.reservation_required !== 'boolean') {
    throw createUsageError(503, 'IAM_MODEL_USAGE_RESERVATION_REJECTED', 'IAM 模型额度预留未获批准')
  }
  return {
    requestId,
    context,
    gatewayKey,
    reservationRequired: result.reservation_required,
    estimatedInputTokens,
    startedAt: Date.now(),
  }
}

/** 从 Provider 字段读取实测 Token；缺字段时明确估算并给账本标记。 */
function resolveUsage(rawUsage, handle, outputText) {
  const input = rawUsage?.prompt_tokens ?? rawUsage?.input_tokens
  const output = rawUsage?.completion_tokens ?? rawUsage?.output_tokens
  const inputMeasured = input !== undefined && input !== null
    && Number.isSafeInteger(Number(input)) && Number(input) >= 0
  const outputMeasured = output !== undefined && output !== null
    && Number.isSafeInteger(Number(output)) && Number(output) >= 0
  const inputTokens = Math.min(MAX_TOKENS, inputMeasured ? Number(input) : handle.estimatedInputTokens)
  const outputTokens = Math.min(MAX_TOKENS, outputMeasured ? Number(output) : estimateTextTokens(outputText))
  return { inputTokens, outputTokens, usageIsEstimated: !inputMeasured || !outputMeasured }
}

/** 调用后原子结算预留或写入实际账目；同一 request_id 的安全重试由 IAM 保证幂等。 */
async function settleIamModelUsage(handle, rawUsage, outcome, outputText = '') {
  if (!handle) return
  const { inputTokens, outputTokens, usageIsEstimated } = resolveUsage(rawUsage, handle, outputText)
  const latencyMs = Math.max(0, Math.min(86_400_000, Date.now() - handle.startedAt))
  const payload = {
    request_id: handle.requestId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    outcome,
    usage_is_estimated: usageIsEstimated,
    latency_ms: latencyMs,
  }
  const path = handle.reservationRequired ? '/reservations/settle' : ''
  const report = handle.reservationRequired ? payload : {
    ...payload,
    tenant_id: handle.context.tenantId,
    model_id: handle.context.modelId,
    application_id: handle.context.applicationId,
    user_id: handle.context.subject,
  }

  // 网络超时可能发生在 IAM 已提交事务之后；重复相同 request_id/载荷是幂等的。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await postUsage(path, report, handle.gatewayKey)
      return
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  throw createUsageError(503, 'IAM_MODEL_USAGE_SETTLEMENT_FAILED', 'IAM 模型用量结算暂不可用')
}

module.exports = {
  estimateTextTokens,
  reserveIamModelUsage,
  settleIamModelUsage,
}
