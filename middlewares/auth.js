/**
 * 认证中间件
 * 从请求头提取 JWT，验证后将用户信息挂在 req.user 上
 */

const { getUserByToken } = require('../services/auth/auth.service');
const { ensureUserProfile } = require('../services/user_profile_service');

async function authRequired(req, res, next) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ detail: '未提供有效的认证令牌' });
  }

  try {
    const token = authorization.slice(7);
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ detail: '令牌无效或已过期' });
    }

    const profile = await ensureUserProfile(user);
    if (profile.status === 'BANNED') {
      return res.status(403).json({ detail: '账号已被封禁，请联系管理员' });
    }
    // 将业务资料挂到 req.user，后续路由可直接读取角色和权限。
    req.user = {
      ...user,
      profile,
      role: profile.role,
      permissions: profile.permissions,
    };
    return next();
  } catch (e) {
    return res.status(500).json({ detail: `读取用户权限失败：${e.message}` });
  }
}

/**
 * AI 邮箱门禁。
 * 必须放在 authRequired 之后使用，服务端以数据库中的邮箱与验证状态为最终依据。
 */
function emailBindingRequired(req, res, next) {
  const emailBound = req.user?.email_bound === true || req.user?.email_verified === true;
  if (!emailBound) {
    return res.status(403).json({
      detail: '使用 AI 功能前请先绑定并验证邮箱',
      code: 'EMAIL_BINDING_REQUIRED',
    });
  }
  return next();
}

module.exports = { authRequired, emailBindingRequired };
