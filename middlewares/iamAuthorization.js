/**
 * IAM 权限中间件。
 * 仅已显式绑定 IAM 的用户在线检查中心权限；未绑定用户保持兼容本地 RBAC 双轨运行。
 */
const {
  getIamIdentityLink,
  requireIamPermission,
} = require('../services/iam/iamAuthorization.service')
const { settings } = require('../config')
const { createIamAuthorizationGuard } = require('./iamAuthorizationGuard')

// 每个动作映射到平台稳定权限码；模型实例授权由 Provider 出站服务单独检查。
const iamAuthorizationRequired = createIamAuthorizationGuard({
  getIamIdentityLink,
  requireIamPermission,
  permissionCodes: {
    read: { code: settings.IAM_RESUME_READ_PERMISSION_CODE, resourceScoped: true },
    write: { code: settings.IAM_RESUME_WRITE_PERMISSION_CODE, resourceScoped: true },
    export: { code: settings.IAM_RESUME_EXPORT_PERMISSION_CODE, resourceScoped: true },
    ai: { code: settings.IAM_AI_PERMISSION_CODE, resourceScoped: false },
  },
})

module.exports = { iamAuthorizationRequired }
