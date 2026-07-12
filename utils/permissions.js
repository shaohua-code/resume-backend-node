/**
 * 角色权限配置
 * 后端最终权限来源，前端只用于展示和路由提示，不能替代后端校验。
 */

const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  USER: 'USER',
}

const PERMISSIONS = {
  ADMIN_DASHBOARD: 'admin:dashboard',
  ADMIN_MANAGE_ADMINS: 'admin:manage_admins',
  ADMIN_MANAGE_USERS: 'admin:manage_users',
  ADMIN_VIEW_AI_CALLS: 'admin:view_ai_calls',
  ADMIN_SYSTEM_CONFIG: 'admin:system_config',
  ADMIN_ANNOUNCEMENT: 'admin:announcement',
  ADMIN_AI_MODEL: 'admin:ai_model',
  ADMIN_STATS: 'admin:stats',
  ADMIN_VIEW_RESUMES: 'admin:view_resumes',
  ADMIN_VIEW_FEEDBACK: 'admin:view_feedback',
  ADMIN_VIEW_VISITS: 'admin:view_visits',
  ADMIN_WALLET: 'admin:wallet',
  // 新增：消费记录、邀请链接、认领用户权限
  ADMIN_VIEW_LEDGERS: 'admin:view_ledgers',
  ADMIN_MANAGE_INVITE_LINKS: 'admin:manage_invite_links',
  ADMIN_CLAIM_USERS: 'admin:claim_users',
  ADMIN_RECHARGE_MANAGE: 'admin:recharge_manage',
  ADMIN_VIEW_RECHARGE_REQUESTS: 'admin:view_recharge_requests',
  ADMIN_APPROVE_RECHARGE: 'admin:approve_recharge',
  ADMIN_RECHARGE_EMAIL_TEMPLATE: 'admin:recharge_email_template',
  USER_RESUME_CREATE: 'user:resume_create',
  USER_RESUME_EDIT: 'user:resume_edit',
  WALLET_VIEW_SELF: 'wallet:view_self',
  WALLET_MANAGE_USERS: 'wallet:manage_users',
  WALLET_GRANT_USERS: 'wallet:grant_users',
}

const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.ADMIN_MANAGE_ADMINS,
    PERMISSIONS.ADMIN_MANAGE_USERS,
    PERMISSIONS.ADMIN_VIEW_AI_CALLS,
    PERMISSIONS.ADMIN_SYSTEM_CONFIG,
    PERMISSIONS.ADMIN_ANNOUNCEMENT,
    PERMISSIONS.ADMIN_AI_MODEL,
    PERMISSIONS.ADMIN_STATS,
    PERMISSIONS.ADMIN_VIEW_RESUMES,
    PERMISSIONS.ADMIN_VIEW_FEEDBACK,
    PERMISSIONS.ADMIN_VIEW_VISITS,
    PERMISSIONS.ADMIN_WALLET,
    PERMISSIONS.ADMIN_VIEW_LEDGERS,
    PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS,
    PERMISSIONS.ADMIN_CLAIM_USERS,
    PERMISSIONS.ADMIN_RECHARGE_MANAGE,
    PERMISSIONS.ADMIN_VIEW_RECHARGE_REQUESTS,
    PERMISSIONS.ADMIN_APPROVE_RECHARGE,
    PERMISSIONS.ADMIN_RECHARGE_EMAIL_TEMPLATE,
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.WALLET_VIEW_SELF,
    PERMISSIONS.WALLET_MANAGE_USERS,
    PERMISSIONS.WALLET_GRANT_USERS,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.ADMIN_MANAGE_USERS,
    PERMISSIONS.ADMIN_VIEW_AI_CALLS,
    PERMISSIONS.ADMIN_VIEW_RESUMES,
    PERMISSIONS.ADMIN_STATS,
    PERMISSIONS.ADMIN_WALLET,
    // 新增权限：消费记录、邀请链接、认领用户
    PERMISSIONS.ADMIN_VIEW_LEDGERS,
    PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS,
    PERMISSIONS.ADMIN_CLAIM_USERS,
    PERMISSIONS.ADMIN_RECHARGE_MANAGE,
    PERMISSIONS.ADMIN_VIEW_RECHARGE_REQUESTS,
    PERMISSIONS.ADMIN_APPROVE_RECHARGE,
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.WALLET_VIEW_SELF,
    PERMISSIONS.WALLET_GRANT_USERS,
  ],
  [ROLES.USER]: [
    PERMISSIONS.USER_RESUME_CREATE,
    PERMISSIONS.USER_RESUME_EDIT,
    PERMISSIONS.WALLET_VIEW_SELF,
  ],
}

function getEffectiveRole(profile) {
  return profile && profile.role ? profile.role : ROLES.USER
}

function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[ROLES.USER]
}

function hasPermission(role, permission) {
  return getRolePermissions(role).includes(permission)
}

function isAdminRole(role) {
  return role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN
}

function canManageRole(operatorRole, targetRole) {
  if (operatorRole === ROLES.SUPER_ADMIN) {
    return true
  }
  // 普通管理员只能管理普通用户
  return operatorRole === ROLES.ADMIN && targetRole === ROLES.USER
}

module.exports = {
  ROLES,
  PERMISSIONS,
  getEffectiveRole,
  getRolePermissions,
  hasPermission,
  isAdminRole,
  canManageRole,
}
