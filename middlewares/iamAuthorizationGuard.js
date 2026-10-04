/**
 * 创建 IAM 权限守卫的纯函数工厂，便于隔离验证中心授权与本地兼容边界。
 * 数据库绑定状态与远程权限检查由调用方注入，不在请求中信任浏览器提交的主体。
 */

/** 从业务请求提取资源标识；该值只作为授权上下文，不替代仓储所有者过滤。 */
function getResourceId(req) {
  const value = req.params?.id || req.query?.resume_id || req.body?.resume_id || req.body?.id
  return value === undefined || value === null || value === '' ? undefined : String(value).slice(0, 256)
}

/**
 * 根据用户是否显式绑定 IAM 决定是否调用中心授权。
 * 仅未绑定账号走原本地 RBAC 路径；已绑定账号遇到任一故障都 fail closed。
 */
function createIamAuthorizationGuard({ getIamIdentityLink, requireIamPermission, permissionCodes }) {
  if (typeof getIamIdentityLink !== 'function' || typeof requireIamPermission !== 'function') {
    throw new TypeError('IAM 授权守卫必须提供身份查询和权限检查函数')
  }
  if (!permissionCodes || typeof permissionCodes !== 'object') {
    throw new TypeError('IAM 授权守卫必须提供权限动作映射')
  }

  return function iamAuthorizationRequired(action) {
    const permission = permissionCodes[action]
    if (!permission?.code) throw new Error(`未知的 IAM 授权动作：${action}`)

    return async function checkIamPermission(req, res, next) {
      try {
        // 用户主键来自已经完成本地认证的服务端会话。
        if (!await getIamIdentityLink(req.user.id)) return next()

        // 本地资源 ID 只用于资源权限判定；AI 功能授权不附带本地业务 ID。
        const resourceId = permission.resourceScoped ? getResourceId(req) : undefined
        await requireIamPermission(req.user.id, permission.code, resourceId)
        return next()
      } catch (error) {
        // 服务端依赖只会透出固定安全消息；未知错误统一隐藏底层详情。
        const statusCode = Number(error?.statusCode) || 503
        const safeMessage = error?.statusCode ? error.message : 'IAM 中央授权暂不可用'
        return res.status(statusCode).json({ detail: safeMessage })
      }
    }
  }
}

module.exports = { createIamAuthorizationGuard, getResourceId }
