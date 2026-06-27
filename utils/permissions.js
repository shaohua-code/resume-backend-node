/**
 * 角色权限配置
 * 这里是后端最终权限来源，前端只用于展示和路由提示，不能替代后端校验。
 */

const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  USER: 'USER',
  VIP: 'VIP',
};

const PERMISSIONS = {
  ADMIN_DASHBOARD: 'admin:dashboard',
  ADMIN_MANAGE_ADMINS: 'admin:manage_admins',
  ADMIN_MANAGE_USERS: 'admin:manage_users',
  ADMIN_VIEW_ORDERS: 'admin:view_orders',
  ADMIN_MANAGE_ORDERS: 'admin:manage_orders',
  ADMIN_VIEW_AI_CALLS: 'admin:view_ai_calls',
  ADMIN_SYSTEM_CONFIG: 'admin:system_config',
  ADMIN_MEMBERSHIP_PLAN: 'admin:membership_plan',
  ADMIN_ANNOUNCEMENT: 'admin:announcement',
  ADMIN_AI_MODEL: 'admin:ai_model',
  ADMIN_STATS: 'admin:stats',
  ADMIN_VIEW_RESUMES: 'admin:view_resumes',
  USER_RESUME_CREATE: 'user:resume_create',
  USER_RESUME_EDIT: 'user:resume_edit',
  USER_AI_LIMITED: 'user:ai_limited',
  USER_UPGRADE_VIP: 'user:upgrade_vip',
  VIP_AI_UNLIMITED: 'vip:ai_unlimited',
  VIP_EXPORT: 'vip:export',
  VIP_ADVANCED_MODEL: 'vip:advanced_model',
  VIP_EXCLUSIVE_TEMPLATE: 'vip:exclusive_template',
};

const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.ADMIN_MANAGE_ADMINS,
    PERMISSIONS.ADMIN_MANAGE_USERS,
    PERMISSIONS.ADMIN_VIEW_ORDERS,
    PERMISSIONS.ADMIN_MANAGE_ORDERS,
    PERMISSIONS.ADMIN_VIEW_AI_CALLS,
    PERMISSIONS.ADMIN_SYSTEM_CONFIG,
    PERMISSIONS.ADMIN_MEMBERSHIP_PLAN,
    PERMISSIONS.ADMIN_ANNOUNCEMENT,
    PERMISSIONS.ADMIN_AI_MODEL,
    PERMISSIONS.ADMIN_STATS,
    PERMISSIONS.ADMIN_VIEW_RESUMES,
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.VIP_AI_UNLIMITED,
    PERMISSIONS.VIP_EXPORT,
    PERMISSIONS.VIP_ADVANCED_MODEL,
    PERMISSIONS.VIP_EXCLUSIVE_TEMPLATE,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.ADMIN_MANAGE_USERS,
    PERMISSIONS.ADMIN_VIEW_ORDERS,
    PERMISSIONS.ADMIN_VIEW_AI_CALLS,
    PERMISSIONS.ADMIN_VIEW_RESUMES,
    PERMISSIONS.ADMIN_STATS,
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.VIP_EXPORT,
  ],
  [ROLES.VIP]: [
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.USER_UPGRADE_VIP,
    PERMISSIONS.VIP_AI_UNLIMITED,
    PERMISSIONS.VIP_EXPORT,
    PERMISSIONS.VIP_ADVANCED_MODEL,
    PERMISSIONS.VIP_EXCLUSIVE_TEMPLATE,
  ],
  [ROLES.USER]: [
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.USER_AI_LIMITED,
    PERMISSIONS.USER_UPGRADE_VIP,
  ],
};

function getEffectiveRole(profile) {
  const role = profile && profile.role ? profile.role : ROLES.USER;
  if (role !== ROLES.VIP) {
    return role;
  }
  if (!profile.vip_expire_time) {
    return ROLES.VIP;
  }
  // VIP 到期后按普通用户权限处理，避免过期会员继续导出或无限调用 AI。
  return new Date(profile.vip_expire_time).getTime() > Date.now() ? ROLES.VIP : ROLES.USER;
}

function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[ROLES.USER];
}

function hasPermission(role, permission) {
  return getRolePermissions(role).includes(permission);
}

function isAdminRole(role) {
  return role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN;
}

function canManageRole(operatorRole, targetRole) {
  if (operatorRole === ROLES.SUPER_ADMIN) {
    return true;
  }
  // 普通管理员只能管理 USER / VIP，不能管理管理员或超级管理员。
  return operatorRole === ROLES.ADMIN && [ROLES.USER, ROLES.VIP].includes(targetRole);
}

module.exports = {
  ROLES,
  PERMISSIONS,
  getEffectiveRole,
  getRolePermissions,
  hasPermission,
  isAdminRole,
  canManageRole,
};
