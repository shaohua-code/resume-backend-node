/**
 * 权限中间件
 * 所有管理接口和高风险业务都通过这里校验，避免只依赖前端隐藏按钮。
 */

const { hasPermission, isAdminRole } = require('../utils/permissions');

function requireRole(roles) {
  const roleList = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user || !roleList.includes(req.user.role)) {
      return res.status(403).json({ detail: '无权访问该资源' });
    }
    next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ detail: '缺少操作权限' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ detail: '仅管理员可访问' });
  }
  next();
}

module.exports = {
  requireRole,
  requirePermission,
  requireAdmin,
};
