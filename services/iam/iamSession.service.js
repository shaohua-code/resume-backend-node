/**
 * IAM RP 令牌保管与续期。
 * 原始 OAuth 令牌只在 Node 服务内存中短暂出现；数据库仅保存 AES-GCM 密文。
 */
const db = require('../../lib/db')
const { settings } = require('../../config')
const { encrypt, decrypt } = require('../../lib/encryption')

/** 不允许使用开发占位密钥加密可续期的中心登录凭证。 */
function assertEncryptionKey() {
  const key = String(settings.IAM_TOKEN_ENCRYPTION_KEY || '')
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('IAM 会话加密密钥未安全配置')
  }
  return key
}

/** 将 IAM token pair 与已显式绑定身份一起写入；调用方可传入事务连接保证原子性。 */
async function saveIamSession(userId, identity, tokenSet, executor = db) {
  const encryptionKey = assertEncryptionKey()
  const accessToken = String(tokenSet?.accessToken || '')
  const refreshToken = String(tokenSet?.refreshToken || '')
  const tenantId = String(tokenSet?.tenantId || '')
  const accessExpiresAt = new Date(tokenSet?.accessExpiresAt)
  if (!accessToken || !refreshToken || !tenantId || Number.isNaN(accessExpiresAt.getTime())) {
    throw new Error('IAM OIDC 会话数据格式无效')
  }

  // INSERT ... SELECT 让数据库再次确认 subject 确实绑定到当前本地用户，避免调用方传错身份。
  const result = await executor.query(
    `INSERT INTO public.iam_oidc_sessions
       (issuer, subject, tenant_id, access_token_ciphertext, refresh_token_ciphertext, access_expires_at)
     SELECT link.issuer, link.subject, $4, $5, $6, $7
     FROM public.iam_identity_links AS link
     WHERE link.issuer = $1 AND link.subject = $2 AND link.user_id = $3
     ON CONFLICT (issuer, subject) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       access_token_ciphertext = EXCLUDED.access_token_ciphertext,
       refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
       access_expires_at = EXCLUDED.access_expires_at,
       updated_at = now()
     RETURNING subject`,
    [
      identity.issuer,
      identity.subject,
      userId,
      tenantId,
      encrypt(accessToken, encryptionKey),
      encrypt(refreshToken, encryptionKey),
      accessExpiresAt,
    ],
  )
  if (!result.rowCount) throw new Error('IAM subject 与本地账号绑定不匹配')
}

/**
 * 为后续服务端中央授权调用提供仍有效的 access token。
 * 行锁确保并发请求只会串行消费 IAM 的一次性 refresh token；续期失败时不返回旧令牌作为授权依据。
 */
async function getFreshIamAccessToken(userId, { issuer, getMetadata, postClientForm, verifyAccessToken }) {
  const encryptionKey = assertEncryptionKey()
  const client = await db.getPool().connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const { rows } = await client.query(
      `SELECT session.subject, session.tenant_id, session.access_token_ciphertext,
              session.refresh_token_ciphertext, session.access_expires_at
       FROM public.iam_oidc_sessions AS session
       JOIN public.iam_identity_links AS link
         ON link.issuer = session.issuer AND link.subject = session.subject
       WHERE link.user_id = $1 AND session.issuer = $2
       FOR UPDATE OF session`,
      [userId, issuer],
    )
    if (!rows.length) throw new Error('IAM 身份尚未绑定')

    const stored = rows[0]
    const accessToken = decrypt(stored.access_token_ciphertext, encryptionKey)
    if (accessToken && new Date(stored.access_expires_at).getTime() > Date.now() + 30_000) {
      await client.query('COMMIT')
      transactionOpen = false
      return { accessToken, subject: stored.subject, tenantId: stored.tenant_id }
    }

    const refreshToken = decrypt(stored.refresh_token_ciphertext, encryptionKey)
    if (!refreshToken) throw new Error('IAM refresh token 不可用')
    const metadata = await getMetadata()
    const tokenSet = await postClientForm(metadata.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const expiresIn = Number(tokenSet.expires_in)
    if (
      String(tokenSet.token_type || '').toLowerCase() !== 'bearer'
      || !tokenSet.access_token
      || !tokenSet.refresh_token
      || tokenSet.refresh_token === refreshToken
      || !Number.isInteger(expiresIn)
      || expiresIn < 1
      || expiresIn > 86_400
    ) {
      throw new Error('IAM refresh response 无效')
    }

    const verified = await verifyAccessToken(tokenSet.access_token, metadata, stored.subject)
    if (verified.tenant_id !== stored.tenant_id) throw new Error('IAM refresh 改变了绑定租户')
    const nextExpiry = new Date(Date.now() + expiresIn * 1000)
    await client.query(
      `UPDATE public.iam_oidc_sessions
       SET access_token_ciphertext = $3,
           refresh_token_ciphertext = $4,
           access_expires_at = $5,
           updated_at = now()
       WHERE issuer = $1 AND subject = $2`,
      [
        issuer,
        stored.subject,
        encrypt(tokenSet.access_token, encryptionKey),
        encrypt(tokenSet.refresh_token, encryptionKey),
        nextExpiry,
      ],
    )
    await client.query('COMMIT')
    transactionOpen = false
    return { accessToken: tokenSet.access_token, subject: stored.subject, tenantId: stored.tenant_id }
  } catch {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 回滚失败也不向调用层透传可能包含连接信息的底层错误。
      }
    }
    // 上游错误正文可能包含敏感协议细节；调用层只收到可处理的统一错误。
    const error = new Error('IAM 中央授权会话不可用')
    error.code = 'IAM_SESSION_UNAVAILABLE'
    throw error
  } finally {
    client.release()
  }
}

module.exports = { saveIamSession, getFreshIamAccessToken }
