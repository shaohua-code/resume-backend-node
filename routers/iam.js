/**
 * IAM OIDC 登录与本地账号显式绑定。
 * 该适配只确认中心身份；简历资源仍使用本地 UUID、角色与现有会话策略。
 */
const express = require('express')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const db = require('../lib/db')
const { settings } = require('../config')
const { authRequired } = require('../middlewares/auth')
const { issueTokenPair } = require('../lib/jwt')
const { ensureUserProfile } = require('../services/user_profile_service')
const { authLimiter } = require('../middlewares/rateLimiter')

const router = express.Router()
router.use(authLimiter)
const STATE_COOKIE = 'iam_oidc_attempt'
const STATE_TTL_MS = 5 * 60 * 1000
let metadataCache = null

/** 规范化 issuer，避免同一提供方因尾斜线生成两条身份映射。 */
function getIssuer() {
  return String(settings.IAM_ISSUER || '').trim().replace(/\/+$/, '')
}

/** 缺少服务端配置时禁用 OIDC；密钥只从部署环境读取。 */
function isEnabled() {
  return Boolean(
    getIssuer()
    && settings.IAM_CLIENT_ID
    && settings.IAM_CLIENT_SECRET
    && settings.IAM_REDIRECT_URI
    && process.env.JWT_SECRET
    && process.env.JWT_SECRET !== 'change-me-in-production'
  )
}

/** 所有动态读取的 OIDC endpoint 必须留在配置的 issuer 源内。 */
function validateEndpoint(value, issuer) {
  const endpoint = new URL(value)
  const origin = new URL(issuer)
  if (endpoint.origin !== origin.origin || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('IAM Discovery 返回了不安全的 endpoint')
  }
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new Error('IAM issuer 必须使用 HTTPS')
  }
  return endpoint.toString()
}

/** 读取并缓存标准 Discovery 元数据；issuer 必须逐字匹配服务端配置。 */
async function getMetadata() {
  if (!isEnabled()) throw new Error('IAM OIDC 尚未配置')
  if (metadataCache && metadataCache.expiresAt > Date.now()) return metadataCache.value
  const issuer = getIssuer()
  const response = await axios.get(issuer + '/.well-known/openid-configuration', { timeout: 10000 })
  const data = response.data || {}
  if (String(data.issuer || '').replace(/\/+$/, '') !== issuer) {
    throw new Error('IAM Discovery issuer 与配置不匹配')
  }
  if (!Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes('S256')) {
    throw new Error('IAM 未公告 PKCE S256 支持')
  }
  if (!Array.isArray(data.token_endpoint_auth_methods_supported)
      || !data.token_endpoint_auth_methods_supported.includes('client_secret_basic')) {
    throw new Error('IAM 未公告 client_secret_basic 支持')
  }
  const value = {
    authorizationEndpoint: validateEndpoint(data.authorization_endpoint, issuer),
    tokenEndpoint: validateEndpoint(data.token_endpoint, issuer),
    introspectionEndpoint: validateEndpoint(data.introspection_endpoint, issuer),
    jwksUri: validateEndpoint(data.jwks_uri, issuer),
  }
  metadataCache = { value, expiresAt: Date.now() + 60 * 1000 }
  return value
}

/** 用应用 JWT 密钥签名一次性登录尝试，防止浏览器改写 intent 或用户 ID。 */
function signAttempt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', settings.JWT_SECRET).update(body).digest('base64url')
  return body + '.' + signature
}

/** 以恒定时间验证登录尝试签名并检查有效期。 */
function verifyAttempt(value) {
  const [body, signature, extra] = String(value || '').split('.')
  if (!body || !signature || extra) return null
  const expected = crypto.createHmac('sha256', settings.JWT_SECRET).update(body).digest()
  let actual
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!Number.isFinite(payload.issuedAt) || payload.issuedAt > Date.now() + 30000 || Date.now() - payload.issuedAt > STATE_TTL_MS) return null
    return payload
  } catch {
    return null
  }
}

/** 从原始 Cookie header 读取状态 cookie，避免新增 cookie-parser 运行依赖。 */
function readCookie(req, name) {
  const entry = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))
  if (!entry) return ''
  try {
    return decodeURIComponent(entry.slice(name.length + 1))
  } catch {
    return ''
  }
}

/** 回调后立即清除一次性状态 cookie。 */
function clearAttemptCookie(res) {
  res.clearCookie(STATE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/iam',
  })
}

/** 创建带 S256 PKCE、state 和 nonce 的授权请求。 */
async function beginAuthorization(res, intent, localUserId = null) {
  const metadata = await getMetadata()
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = crypto.randomBytes(32).toString('base64url')
  const nonce = crypto.randomBytes(32).toString('base64url')
  const payload = { state, issuedAt: Date.now() }
  const stateHash = crypto.createHash('sha256').update(state).digest('hex')
  await db.query('DELETE FROM public.iam_oidc_attempts WHERE expires_at <= now()')
  await db.query(
    "INSERT INTO public.iam_oidc_attempts (state_hash, nonce, code_verifier, intent, local_user_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')",
    [stateHash, nonce, verifier, intent, localUserId],
  )
  res.cookie(STATE_COOKIE, signAttempt(payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: STATE_TTL_MS,
    path: '/api/auth/iam',
  })
  const url = new URL(metadata.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: settings.IAM_CLIENT_ID,
    redirect_uri: settings.IAM_REDIRECT_URI,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/** 用指定客户端 Basic 凭证提交表单，所有协议错误均 fail closed。 */
async function postClientForm(endpoint, values) {
  const clientId = encodeURIComponent(settings.IAM_CLIENT_ID)
  const clientSecret = encodeURIComponent(settings.IAM_CLIENT_SECRET)
  const authorization = Buffer.from(clientId + ':' + clientSecret).toString('base64')
  const body = new URLSearchParams(values).toString()
  const response = await axios.post(endpoint, body, {
    timeout: 10000,
    headers: {
      Authorization: 'Basic ' + authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  return response.data || {}
}

/** 按 JWKS 的 kid 找 RS256 公钥，并校验 ID Token 的 issuer、audience、时效与 nonce。 */
async function verifyIdToken(rawToken, metadata, expectedNonce) {
  const decoded = jwt.decode(rawToken, { complete: true })
  if (!decoded || decoded.header.alg !== 'RS256' || !decoded.header.kid) {
    throw new Error('IAM ID Token 签名算法无效')
  }
  const issuer = getIssuer()
  const response = await axios.get(metadata.jwksUri, { timeout: 10000 })
  const jwk = (response.data?.keys || []).find((key) => key.kid === decoded.header.kid && key.kty === 'RSA')
  if (!jwk) throw new Error('IAM JWKS 中找不到 ID Token 签名密钥')
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const claims = jwt.verify(rawToken, key, {
    algorithms: ['RS256'],
    issuer,
    audience: settings.IAM_CLIENT_ID,
    clockTolerance: 30,
    maxAge: '10m',
  })
  if (!claims.sub || claims.nonce !== expectedNonce) throw new Error('IAM ID Token subject 或 nonce 无效')
  return claims
}

/** 在线内省 access token，避免仅凭签名接受已撤销或发给其他客户端的令牌。 */
async function verifyAccessToken(token, metadata, subject) {
  const result = await postClientForm(metadata.introspectionEndpoint, {
    token,
    token_type_hint: 'access_token',
  })
  if (
    result.active !== true
    || result.sub !== subject
    || result.client_id !== settings.IAM_CLIENT_ID
    || result.iss !== getIssuer()
    || !result.tenant_id
  ) {
    throw new Error('IAM access token 已失效或客户端归属不符')
  }
}

/** 交换授权码并验证本次登录的 ID Token 与 access token。 */
async function completeAuthorization(code, attempt) {
  const metadata = await getMetadata()
  const token = await postClientForm(metadata.tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: settings.IAM_REDIRECT_URI,
    code_verifier: attempt.verifier,
  })
  if (String(token.token_type || '').toLowerCase() !== 'bearer' || !token.access_token || !token.id_token) {
    throw new Error('IAM token response 格式无效')
  }
  const claims = await verifyIdToken(token.id_token, metadata, attempt.nonce)
  if (claims.at_hash) {
    const expectedAtHash = crypto.createHash('sha256').update(token.access_token).digest().subarray(0, 16).toString('base64url')
    if (claims.at_hash !== expectedAtHash) throw new Error('IAM ID Token at_hash 与 access token 不匹配')
  }
  await verifyAccessToken(token.access_token, metadata, claims.sub)
  return { subject: claims.sub, issuer: getIssuer() }
}

/** 仅用本地用户 UUID 关联中心 subject；不按 email 自动合并任何账号。 */
async function linkIdentity(localUserId, identity) {
  const client = await db.getPool().connect()
  try {
    await client.query('BEGIN')
    const user = await client.query(
      'SELECT id FROM public.users WHERE id = $1 FOR UPDATE',
      [localUserId],
    )
    if (!user.rowCount) throw new Error('本地账号不存在')
    await client.query(
      'INSERT INTO public.iam_identity_links (issuer, subject, user_id) VALUES ($1, $2, $3)',
      [identity.issuer, identity.subject, localUserId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** 生成短时单次兑换码；前端只会拿到该随机码，不会在 URL 中收到本地 JWT。 */
async function createLoginCode(userId) {
  const code = crypto.randomBytes(32).toString('base64url')
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  await db.query('DELETE FROM public.iam_login_codes WHERE expires_at <= now()')
  await db.query(
    'INSERT INTO public.iam_login_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + interval \'90 seconds\')',
    [codeHash, userId],
  )
  return code
}

/** 校验本地账号状态后沿用现有角色和权限生成本地会话。 */
async function createLocalSession(userId) {
  const { rows } = await db.query(
    'SELECT u.*, p.nickname, p.status AS profile_status FROM public.users u LEFT JOIN public.user_profile p ON p.user_id = u.id WHERE u.id = $1 LIMIT 1',
    [userId],
  )
  const row = rows[0]
  if (!row) throw new Error('本地账号不存在')
  const user = {
    id: row.id,
    account: row.account || null,
    email: row.email || null,
    email_verified: row.email_verified === true,
    session_version: Number(row.session_version || 0),
    user_metadata: { username: row.account || '', nickname: row.nickname || '' },
  }
  const profile = await ensureUserProfile(user)
  if (String(row.profile_status || profile.status || '').toUpperCase() === 'BANNED') {
    throw new Error('本地账号已被封禁')
  }
  const session = await issueTokenPair(user)
  return {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    account: user.account,
    email: user.email,
    email_verified: user.email_verified,
    email_bound: user.email_verified,
    nickname: profile.nickname,
    user_id: user.id,
    role: profile.role,
    status: profile.status,
    permissions: profile.permissions,
  }
}

/** 暴露是否完成服务端配置，不回显 client secret 或任何密钥。 */
router.get('/config', (_req, res) => res.set('Cache-Control', 'no-store').json({ enabled: isEnabled() }))

/** 发起 IAM 登录，只有已显式绑定的本地账号可以兑换成业务会话。 */
router.post('/login/start', async (_req, res) => {
  try {
    const authorizationUrl = await beginAuthorization(res, 'login')
    return res.set('Cache-Control', 'no-store').json({ authorization_url: authorizationUrl })
  } catch {
    return res.status(503).json({ detail: 'IAM 单点登录暂不可用' })
  }
})

/** 已登录用户主动开始身份绑定，回调 state 会签名绑定当前本地 UUID。 */
router.post('/link/start', authRequired, async (req, res) => {
  try {
    const authorizationUrl = await beginAuthorization(res, 'link', req.user.id)
    return res.set('Cache-Control', 'no-store').json({ authorization_url: authorizationUrl })
  } catch {
    return res.status(503).json({ detail: 'IAM 身份绑定暂不可用' })
  }
})

/** 返回当前用户是否绑定中心身份，不暴露 issuer subject 或其他用户信息。 */
router.get('/link/status', authRequired, async (req, res) => {
  if (!isEnabled()) return res.set('Cache-Control', 'no-store').json({ enabled: false, linked: false })
  const { rows } = await db.query(
    'SELECT 1 FROM public.iam_identity_links WHERE issuer = $1 AND user_id = $2 LIMIT 1',
    [getIssuer(), req.user.id],
  )
  return res.set('Cache-Control', 'no-store').json({ enabled: true, linked: Boolean(rows.length) })
})

/** 校验 OAuth 回调状态、签名、PKCE、ID Token 与实时 access token 后完成登录/绑定。 */
router.get('/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  const attempt = verifyAttempt(readCookie(req, STATE_COOKIE))
  clearAttemptCookie(res)
  const frontend = String(settings.APP_FRONTEND_URL || '').replace(/\/+$/, '')
  const fail = () => res.redirect(frontend + '/login?iam_error=login_failed')
  if (!attempt || typeof req.query.state !== 'string' || req.query.state !== attempt.state || req.query.error) return fail()
  if (String(req.query.iss || '').replace(/\/+$/, '') !== getIssuer()) return fail()
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (!code || code.length > 2048) return fail()
  try {
    const stateHash = crypto.createHash('sha256').update(attempt.state).digest('hex')
    const consumed = await db.query(
      'DELETE FROM public.iam_oidc_attempts WHERE state_hash = $1 AND expires_at > now() RETURNING nonce, code_verifier, intent, local_user_id',
      [stateHash],
    )
    if (!consumed.rows.length) return fail()
    const stored = consumed.rows[0]
    const oidcAttempt = {
      ...attempt,
      nonce: stored.nonce,
      verifier: stored.code_verifier,
      intent: stored.intent,
      localUserId: stored.local_user_id,
    }
    const identity = await completeAuthorization(code, oidcAttempt)
    if (oidcAttempt.intent === 'link' && oidcAttempt.localUserId) {
      await linkIdentity(oidcAttempt.localUserId, identity)
      return res.redirect(frontend + '/user?tab=profile&iam_linked=1')
    }
    const { rows } = await db.query(
      'SELECT user_id FROM public.iam_identity_links WHERE issuer = $1 AND subject = $2 LIMIT 1',
      [identity.issuer, identity.subject],
    )
    if (!rows.length) return res.redirect(frontend + '/login?iam_error=identity_not_linked')
    const loginCode = await createLoginCode(rows[0].user_id)
    return res.redirect(frontend + '/login#iam_code=' + encodeURIComponent(loginCode))
  } catch {
    return fail()
  }
})

/** 原子消费 90 秒桥接码，并签发兼容现有前端与权限中间件的本地 JWT。 */
router.post('/exchange', async (req, res) => {
  const code = String(req.body?.code || '')
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(code)) {
    return res.status(400).json({ detail: 'IAM 登录凭证无效或已过期' })
  }
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  const { rows } = await db.query(
    'DELETE FROM public.iam_login_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id',
    [codeHash],
  )
  if (!rows.length) return res.status(401).json({ detail: 'IAM 登录凭证无效或已过期' })
  try {
    return res.set('Cache-Control', 'no-store').json(await createLocalSession(rows[0].user_id))
  } catch {
    return res.status(403).json({ detail: '本地账号不可用，请使用原登录方式联系管理员' })
  }
})

module.exports = router
