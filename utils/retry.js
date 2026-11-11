/**
 * 重试工具模块
 * 提供可配置的指数退避重试策略，用于 AI 调用等网络请求
 */

/**
 * 默认配置
 */
const DEFAULT_RETRY_CONFIG = {
  // 最大重试次数（不含首次调用）
  maxRetries: 2,
  // 初始退避时间（毫秒）
  initialDelayMs: 1000,
  // 最大退避时间（毫秒）
  maxDelayMs: 10000,
  // 退避倍数
  backoffMultiplier: 2,
  // 是否添加随机抖动（避免雷同时刻重试）
  jitter: true,
  // 抖动范围（0-1）
  jitterFactor: 0.2,
}

/**
 * 可重试的错误码列表
 * 仅对临时性网络/服务错误进行重试，业务错误不重试
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',      // 连接被重置
  'ECONNABORTED',    // 连接中止
  'ETIMEDOUT',       // 连接超时
  'EAI_AGAIN',       // DNS 临时失败
  'ENOTFOUND',       // DNS 解析失败（可能是临时网络问题）
  'ECONNREFUSED',    // 连接被拒绝
  'EPIPE',           // 管道断开
  'EHOSTUNREACH',    // 主机不可达
  'ENETUNREACH',     // 网络不可达
])

/**
 * 可重试的 HTTP 状态码
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
])

/**
 * 判断错误是否可重试
 * @param {Error} error 错误对象
 * @returns {boolean} 是否可重试
 */
function isRetryableError(error) {
  if (!error) return false

  // 检查错误码
  if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) {
    return true
  }

  // 检查 axios 错误的响应状态码
  const status = error.response?.status
  if (status && RETRYABLE_STATUS_CODES.has(status)) {
    return true
  }

  // 检查是否是超时错误
  if (error.message && /timeout/i.test(error.message)) {
    return true
  }

  // 检查 axios 的 ECONNABORTED（超时）
  if (error.code === 'ECONNABORTED') {
    return true
  }

  return false
}

/**
 * 计算退避延迟时间
 * @param {number} attempt 当前重试次数（从 1 开始）
 * @param {Object} config 配置
 * @returns {number} 延迟毫秒数
 */
function calculateDelay(attempt, config) {
  const {
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    jitter,
    jitterFactor,
  } = { ...DEFAULT_RETRY_CONFIG, ...config }

  // 指数退避：delay = initial * multiplier^(attempt-1)
  let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1)

  // 限制最大延迟
  delay = Math.min(delay, maxDelayMs)

  // 添加随机抖动
  if (jitter) {
    const jitterRange = delay * jitterFactor
    const jitterValue = (Math.random() * 2 - 1) * jitterRange
    delay = Math.max(0, delay + jitterValue)
  }

  return Math.round(delay)
}

/**
 * 等待指定毫秒
 * @param {number} ms 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带重试的异步函数执行器
 *
 * @param {Function} fn 要执行的异步函数
 * @param {Object} options 配置选项
 * @param {number} options.maxRetries 最大重试次数
 * @param {number} options.initialDelayMs 初始退避时间
 * @param {number} options.maxDelayMs 最大退避时间
 * @param {number} options.backoffMultiplier 退避倍数
 * @param {boolean} options.jitter 是否添加抖动
 * @param {Function} options.shouldRetry 自定义判断是否重试的函数
 * @param {Function} options.onRetry 重试时的回调函数
 * @returns {Promise<any>} 函数执行结果
 */
async function withRetry(fn, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options }
  const { maxRetries, shouldRetry, onRetry } = config

  let lastError
  let attempt = 0

  while (attempt <= maxRetries) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      attempt += 1

      // 判断是否应该重试
      const canRetry = shouldRetry
        ? shouldRetry(error, attempt)
        : isRetryableError(error)

      if (!canRetry || attempt > maxRetries) {
        throw error
      }

      // 计算延迟时间
      const delay = calculateDelay(attempt, config)

      // 触发重试回调
      if (typeof onRetry === 'function') {
        onRetry({
          error,
          attempt,
          maxRetries,
          delay,
          willRetry: true,
        })
      }

      // 等待后重试
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * 创建带重试能力的函数包装器
 *
 * @param {Object} defaultConfig 默认重试配置
 * @returns {Function} 包装函数
 */
function createRetryWrapper(defaultConfig = {}) {
  const baseConfig = { ...DEFAULT_RETRY_CONFIG, ...defaultConfig }

  return function retryWrapper(fn, overrideConfig = {}) {
    const config = { ...baseConfig, ...overrideConfig }
    return (...args) => withRetry(() => fn(...args), config)
  }
}

/**
 * AI 调用专用重试配置
 * 针对 AI 模型调用的特点进行优化：
 * - 较长的初始等待时间（模型服务可能需要预热）
 * - 较大的最大延迟（避免频繁重试加重服务压力）
 * - 较少的重试次数（AI 调用成本较高）
 */
const AI_RETRY_CONFIG = {
  maxRetries: 1,           // AI 调用只重试 1 次（控制成本）
  initialDelayMs: 2000,    // 初始等待 2 秒
  maxDelayMs: 8000,        // 最大等待 8 秒
  backoffMultiplier: 2,
  jitter: true,
  jitterFactor: 0.3,
}

/**
 * 创建 AI 调用重试包装器
 * @param {Function} onRetry 重试回调
 * @returns {Function} 重试执行器
 */
function createAiRetryExecutor(onRetry) {
  return (fn) => withRetry(fn, {
    ...AI_RETRY_CONFIG,
    onRetry,
  })
}

module.exports = {
  DEFAULT_RETRY_CONFIG,
  AI_RETRY_CONFIG,
  RETRYABLE_ERROR_CODES,
  RETRYABLE_STATUS_CODES,
  isRetryableError,
  calculateDelay,
  sleep,
  withRetry,
  createRetryWrapper,
  createAiRetryExecutor,
}
