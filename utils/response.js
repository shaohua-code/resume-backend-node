/**
 * 统一响应封装
 * 提供 success / error 两种标准返回格式，减少控制器重复代码
 */

function success(res, data, message = '') {
  return res.json({ success: true, data, message });
}

function error(res, statusCode, message, extra = {}) {
  return res.status(statusCode).json({ detail: message, ...extra });
}

module.exports = {
  success,
  error,
};
