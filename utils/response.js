/**
 * 统一响应封装
 * 提供 success / error 两种标准返回格式，并对 500 类错误做用户可读脱敏
 */

const BUSY_MESSAGE = '服务暂时繁忙，请稍后重试'

/** 疑似驱动/堆栈/SQL 等不应直接返回给前端的原文 */
const TECHNICAL_PATTERN = /(at\s+\S+|stack|ECONN|ENOENT|postgres|sql|syntax error|TypeError|ReferenceError|Cannot read|ETIMEDOUT|ECONNREFUSED|relation "|column )/i

function success(res, data, message = '') {
  return res.json({ success: true, data, message });
}

function error(res, statusCode, message, extra = {}) {
  const code = Number(statusCode) || 500;
  const safeMessage = sanitizePublicError(code, message);
  return res.status(code).json({ detail: safeMessage, ...extra });
}

/**
 * 控制器通用失败出口：业务 statusCode 保留中文 detail；未知 500 脱敏。
 * @param {import('express').Response} res
 * @param {Error & { statusCode?: number, code?: string }} err
 */
function handleError(res, err) {
  const statusCode = err?.statusCode || 500;
  const extra = {};
  if (err?.code) extra.code = err.code;
  return error(res, statusCode, err?.message || BUSY_MESSAGE, extra);
}

function sanitizePublicError(statusCode, message) {
  const text = String(message || '').trim();
  if (!text) return statusCode >= 500 ? BUSY_MESSAGE : '操作失败，请稍后重试';
  // 明确业务错误（4xx）且非技术噪声时原样返回
  if (statusCode < 500 && !TECHNICAL_PATTERN.test(text)) return text;
  if (statusCode >= 500) {
    // 生产环境绝不透出内部细节；开发环境同样对技术噪声脱敏，避免用户看到英文堆栈
    if (TECHNICAL_PATTERN.test(text) || process.env.NODE_ENV === 'production') {
      return BUSY_MESSAGE;
    }
  }
  if (TECHNICAL_PATTERN.test(text)) return BUSY_MESSAGE;
  return text;
}

module.exports = {
  success,
  error,
  handleError,
  sanitizePublicError,
  BUSY_MESSAGE,
};
