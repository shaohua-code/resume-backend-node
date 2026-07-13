/**
 * API 速率限制中间件
 * 使用 express-rate-limit 防止暴力破解、DDoS、短信/邮件轰炸
 *
 * 使用场景：
 * - 认证接口（登录、验证码发送）防止暴力破解
 * - 敏感操作（密码重置、注册）防止滥用
 * - 全局保护防止 DDoS 攻击
 */

const rateLimit = require('express-rate-limit')
// 导入官方 IP key 生成器（正确处理 IPv6 地址标准化）
const { ipKeyGenerator } = require('express-rate-limit')

/**
 * 认证接口限流器（严格）
 * 适用于：登录、发送验证码、密码重置等敏感操作
 *
 * 限制规则：
 * - 每个 IP 每分钟最多 5 次请求
 * - 超出限制返回 429 状态码和友好提示
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟窗口
  max: 5,               // 每个 IP 最多 5 次
  message: {
    success: false,
    detail: '操作过于频繁，请稍后再试（每分钟限制 5 次）',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,   // 返回 RateLimit-* 标准头信息
  legacyHeaders: false,    // 禁用 X-RateLimit-* 旧版头
  // 使用官方 IP key 生成器（自动处理 IPv4/IPv6 标准化，防绕过）
  keyGenerator: ipKeyGenerator,
  // 跳过白名单（如内网 IP、测试环境）
  skip: (req) => {
    // 开发环境可跳过限制（方便调试）
    if (process.env.NODE_ENV === 'development') {
      return true
    }
    return false
  },
})

/**
 * 注册接口限流器（中等严格）
 * 适用于：用户注册、邮箱验证等
 *
 * 限制规则：
 * - 每个 IP 每小时最多 10 次请求
 * - 防止恶意批量注册
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 小时窗口
  max: 10,                  // 每个 IP 最多 10 次
  message: {
    success: false,
    detail: '注册频率超限，请 1 小时后再试',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
})

/**
 * 全局通用限流器（宽松）
 * 适用于：所有 API 接口的基础保护
 *
 * 限制规则：
 * - 每个 IP 每分钟最多 100 次请求
 * - 防止 DDoS 和爬虫滥用
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟窗口
  max: 100,             // 每个 IP 最多 100 次
  message: {
    success: false,
    detail: '服务器繁忙，请稍后再试',
    code: 'GLOBAL_RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
})

module.exports = {
  authLimiter,      // 认证接口专用（最严格）
  registerLimiter,  // 注册接口专用（中等）
  globalLimiter,    // 全局通用（宽松）
}
