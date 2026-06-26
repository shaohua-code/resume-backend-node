/**
 * 认证中间件
 * 从请求头中提取 access_token，调用 Supabase 验证后将用户信息挂在 req.user 上
 * 请求头格式：Authorization: Bearer <access_token>
 */

const { getUserByToken } = require('../services/auth_service');

async function authRequired(req, res, next) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ detail: '未提供有效的认证令牌' });
  }
  const token = authorization.slice(7);
  const user = await getUserByToken(token);
  if (!user) {
    return res.status(401).json({ detail: '令牌无效或已过期' });
  }
  // 将 Supabase user 对象挂到 req.user 上，包含 id（uuid）、email、user_metadata 等
  req.user = user;
  next();
}

module.exports = { authRequired };
