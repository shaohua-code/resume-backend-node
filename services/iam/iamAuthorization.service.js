/**
 * AI 简历业务请求的 IAM 在线授权适配。
 * 中心身份只从加密会话库读取；用户主键、租户和 subject 都不接受浏览器提供。
 */
const axios = require('axios')
const db = require('../../lib/db')
const { settings } = require('../../config')
const { getFreshIamAccessToken } = require('./iamSession.service')

const DISCOVERY_TTL_MS = 60 * 1000
let discoveryCache = null

/** 识别任意残留的 IAM 配置，避免绑定账号因部分配置而隐式退回本地授权。 */
function hasIamIntegrationSettings() {
  return Boolean(
    settings.IAM_ISSUER || settings.IAM_CLIENT_ID || settings.IAM_CLIENT_SECRET || settings.IAM_TOKEN_ENCRYPTION_KEY,
  )
}

/** 以同一个规范化 issuer 读取 Discovery，拒绝跳转到其他来源的 endpoint。 */
function getIssuer() {
  return String(settings.IAM_ISSUER || '').trim().replace(/\/+$/, '')
}

/** 检查中央会话加密所需配置；未启用 IAM 时保留既有本地登录路径。 */
function isIamAuthorizationEnabled() {
  return Boolean(
    getIssuer()
    && settings.IAM_CLIENT_ID
    && settings.IAM_CLIENT_SECRET
    && Buffer.byteLength(String(settings.IAM_TOKEN_ENCRYPTION_KEY || ''), 'utf8') >= 32,
  )
}

/**
 * 只根据后端绑定表确定是否属于 IAM 用户；旧库仅在未配置 IAM 且表不存在时走本地授权。
 * 表中仍有绑定却缺少 IAM 配置时必须失败，不能把配置删除当作降级开关。
 */
async function getIamIdentityLink(userId) {
  if (!userId) return false
  const integrationConfigured = hasIamIntegrationSettings()
  try {
    const { rows } = await db.query(
      'SELECT issuer FROM public.iam_identity_links WHERE user_id = $1 LIMIT 2',
      [userId],
    )
    if (!rows.length) return false
    if (!integrationConfigured || !isIamAuthorizationEnabled()) {
      throw createAuthorizationError(503, 'IAM 中央授权配置不完整')
    }
    const issuer = getIssuer()
    if (!rows.some((row) => row.issuer === issuer)) {
      throw createAuthorizationError(503, 'IAM 身份提供方与服务配置不匹配')
    }
    return true
  } catch (error) {
    if (error?.statusCode) throw error
    if (!integrationConfigured && error?.code === '42P01') return false
    throw createAuthorizationError(503, 'IAM 身份绑定状态暂不可用')
  }
}

/** 解析可信部署配置中的 tenant_id -> model_key -> IAM model_catalog UUID 映射。 */
function getIamModelId(modelKey, tenantId) {
  let mapping
  try {
    mapping = JSON.parse(String(settings.IAM_MODEL_ID_MAP_JSON || '{}'))
  } catch {
    throw createAuthorizationError(503, 'IAM 模型权限映射配置无效')
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw createAuthorizationError(503, 'IAM 模型权限映射配置无效')
  }
  // 多租户部署优先按当前已验签会话的 tenant_id 取模型映射，不能混用其他租户目录项。
  // 保留扁平映射兼容单租户部署；IAM 最终仍会验证该模型是否属于令牌租户。
  const tenantMapping = mapping[tenantId]
  const modelId = String(
    tenantMapping && typeof tenantMapping === 'object' && !Array.isArray(tenantMapping)
      ? tenantMapping[modelKey]
      : mapping[modelKey],
  ).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(modelId)) {
    throw createAuthorizationError(503, '当前模型尚未绑定 IAM 模型目录项')
  }
  return modelId
}

/** 已绑定 IAM 的每次 Provider 调用都需拥有实际运行模型的实例级权限。 */
async function requireIamModelPermission(userId, modelKey) {
  const linked = await getIamIdentityLink(userId)
  if (!linked) return false
  try {
    const session = await getIamSession(userId)
    const modelId = getIamModelId(modelKey, session.tenantId)
    const decision = await checkIamPermission(session, 'model.invoke', modelId)
    return {
      tenantId: session.tenantId,
      subject: session.subject,
      applicationId: decision.application_id || '',
      modelId,
    }
  } catch (error) {
    throw normalizeAuthorizationError(error)
  }
}

/** Discovery endpoint 必须与 issuer 同源，生产环境必须使用 HTTPS。 */
function validateEndpoint(value, issuer) {
  const endpoint = new URL(value)
  const origin = new URL(issuer)
  if (endpoint.origin !== origin.origin || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('IAM Discovery endpoint 不安全')
  }
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new Error('IAM issuer 必须使用 HTTPS')
  }
  return endpoint.toString()
}

/** 缓存短时 Discovery 元数据，避免每个业务请求重复读取配置端点。 */
async function getMetadata() {
  if (!isIamAuthorizationEnabled()) throw new Error('IAM 授权未配置')
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.value

  const issuer = getIssuer()
  const { data = {} } = await axios.get(`${issuer}/.well-known/openid-configuration`, {
    timeout: 10000,
    maxRedirects: 0,
  })
  if (String(data.issuer || '').replace(/\/+$/, '') !== issuer) throw new Error('IAM Discovery issuer 不匹配')
  if (!Array.isArray(data.token_endpoint_auth_methods_supported)
      || !data.token_endpoint_auth_methods_supported.includes('client_secret_basic')) {
    throw new Error('IAM 未支持 client_secret_basic')
  }
  const value = {
    tokenEndpoint: validateEndpoint(data.token_endpoint, issuer),
    introspectionEndpoint: validateEndpoint(data.introspection_endpoint, issuer),
  }
  discoveryCache = { value, expiresAt: Date.now() + DISCOVERY_TTL_MS }
  return value
}

/** 通过 OAuth client_secret_basic 调用 token 与 introspection endpoint。 */
async function postClientForm(endpoint, values) {
  const clientId = encodeURIComponent(settings.IAM_CLIENT_ID)
  const clientSecret = encodeURIComponent(settings.IAM_CLIENT_SECRET)
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const { data = {} } = await axios.post(endpoint, new URLSearchParams(values).toString(), {
    timeout: 10000,
    maxRedirects: 0,
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  return data
}

/** 刷新会话后在线内省 token，确保它仍属于绑定的中心用户、租户与客户端。 */
async function verifyAccessToken(token, metadata, subject) {
  const result = await postClientForm(metadata.introspectionEndpoint, {
    token,
    token_type_hint: 'access_token',
  })
  if (result.active !== true || result.sub !== subject
      || result.client_id !== settings.IAM_CLIENT_ID || result.iss !== getIssuer() || !result.tenant_id) {
    throw new Error('IAM access token 无效或上下文不匹配')
  }
  return { tenant_id: result.tenant_id }
}

/** 以本地认证用户为索引取得加密会话中的 IAM access token。 */
async function getIamSession(userId) {
  return getFreshIamAccessToken(userId, {
    issuer: getIssuer(),
    getMetadata,
    postClientForm,
    verifyAccessToken,
  })
}

/** 使用已验签会话执行中心 permission code 判定。 */
async function checkIamPermission(session, permissionCode, resourceId) {
  const { data } = await axios.post(`${getIssuer()}/api/v1/authorization/check`, {
    tenant_id: session.tenantId,
    permission_code: permissionCode,
    ...(resourceId ? { resource_id: resourceId } : {}),
    // 当前简历表没有 tenant_id，不能伪称已在 SQL 中执行 IAM 数据范围。
    include_data_scope: false,
  }, {
    timeout: 10000,
    maxRedirects: 0,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!data || typeof data.allowed !== 'boolean') {
    throw createAuthorizationError(502, 'IAM 授权响应格式无效')
  }
  if (!data.allowed) throw createAuthorizationError(403, '当前账号没有执行该操作的中心权限')
  return data
}

/** 保留明确的拒绝/配置状态；其它上游细节统一隐藏并 fail closed。 */
function normalizeAuthorizationError(error) {
  if (error?.statusCode) return error
  return createAuthorizationError(503, 'IAM 中央授权暂不可用')
}

/** 以本地认证用户为索引取得中心 access token，并执行指定 permission code 判定。 */
async function requireIamPermission(userId, permissionCode, resourceId) {
  try {
    const session = await getIamSession(userId)
    const decision = await checkIamPermission(session, permissionCode, resourceId)
    return { ...session, applicationId: decision.application_id || '' }
  } catch (error) {
    // 不把上游错误正文或 token 写入日志/响应；IAM 不可用时不能回退到本地放行。
    throw normalizeAuthorizationError(error)
  }
}

/** 生成携带 HTTP 状态的安全错误，供路由中间件统一输出。 */
function createAuthorizationError(statusCode, message) {
  const code = statusCode === 403 ? 'IAM_PERMISSION_DENIED' : 'IAM_AUTHORIZATION_UNAVAILABLE'
  return Object.assign(new Error(message), { statusCode, code })
}

module.exports = {
  hasIamIntegrationSettings,
  isIamAuthorizationEnabled,
  getIamIdentityLink,
  requireIamModelPermission,
  requireIamPermission,
  createAuthorizationError,
}
