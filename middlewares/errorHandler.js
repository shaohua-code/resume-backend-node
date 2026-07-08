/**
 * 全局错误处理中间件
 * 统一捕获业务错误并返回标准格式
 */

function errorHandler(err, req, res, next) {
  console.error('[全局错误]', err);
  const statusCode = err.statusCode || 500;
  const message = err.message || '服务器内部错误';
  return res.status(statusCode).json({ detail: message, code: err.code });
}

module.exports = { errorHandler };
