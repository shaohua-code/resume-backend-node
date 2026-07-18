/**
 * JWT 令牌签发与校验
 */

const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { settings } = require('../config')
const db = require('./db')

function parseExpires(str, fallbackSeconds) {
  const match = String(str || '').match(/^(\d+)([smhd])$/i)
  if (!match) return fallbackSeconds
  const n = parseInt(match[1], 10)
  const map = { s: 1, m: 60, h: 3600, d: 86400 }
  return n * (map[match[2].toLowerCase()] || 1)
}

const ACCESS_EXPIRES_SEC = parseExpires(settings.JWT_ACCESS_EXPIRES, 3600)
const REFRESH_EXPIRES_SEC = parseExpires(settings.JWT_REFRESH_EXPIRES, 7 * 86400)

function signAccessToken(user) {
  // 令牌携带基础身份快照；鉴权与邮箱门禁仍会回查数据库中的最新状态。
  return jwt.sign({
    sub: user.id,
    account: user.account || null,
    email: user.email || null,
    email_verified: user.email_verified === true,
    ver: Number(user.session_version || 0),
  }, settings.JWT_SECRET, {
    expiresIn: ACCESS_EXPIRES_SEC,
  })
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, settings.JWT_SECRET)
  } catch {
    return null
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

async function issueTokenPair(user, executor = db) {
  const accessToken = signAccessToken(user)
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_EXPIRES_SEC
  const refreshExpires = new Date(Date.now() + REFRESH_EXPIRES_SEC * 1000).toISOString()

  // 注册和刷新可传入事务 client；令牌记录绑定会话版本，堵住密码重置并发签发旧 refresh token 的窗口。
  await executor.query(
    `INSERT INTO public.refresh_tokens (user_id, token_hash, session_version, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(refreshToken), Number(user.session_version || 0), refreshExpires],
  )

  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt }
}

async function refreshTokenPair(refreshToken) {
  const tokenHash = hashToken(refreshToken)
  const client = await db.getPool().connect()
  let transactionOpen = false

  try {
    await client.query('BEGIN')
    transactionOpen = true

    // DELETE ... RETURNING 原子消费旧令牌；并发刷新只有首个请求能得到 user_id。
    const { rows: consumedRows } = await client.query(
      `DELETE FROM public.refresh_tokens
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING user_id, session_version`,
      [tokenHash],
    )
    if (!consumedRows.length) {
      const err = new Error('刷新令牌无效或已过期')
      err.statusCode = 401
      throw err
    }

    const { rows } = await client.query(
      `SELECT u.id, u.account, u.email, u.email_verified, u.session_version, p.nickname, p.role, p.status
       FROM public.users u
       LEFT JOIN public.user_profile p ON p.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [consumedRows[0].user_id],
    )
    if (!rows.length) {
      const err = new Error('刷新令牌对应的账号不存在')
      err.statusCode = 401
      throw err
    }

    // 旧密码登录或刷新若与密码重置并发，只能拿到旧版本 refresh token，必须在轮换时拒绝。
    if (Number(consumedRows[0].session_version || 0) !== Number(rows[0].session_version || 0)) {
      const err = new Error('刷新令牌对应的会话已失效')
      err.statusCode = 401
      throw err
    }

    // 刷新响应必须保留账号、邮箱绑定状态和昵称，避免前端被旧缓存覆盖。
    const user = {
      id: rows[0].id,
      account: rows[0].account || null,
      email: rows[0].email || null,
      email_verified: rows[0].email_verified === true,
      nickname: rows[0].nickname || null,
      role: rows[0].role || 'USER',
      status: rows[0].status || 'ACTIVE',
      session_version: Number(rows[0].session_version || 0),
    }
    const session = await issueTokenPair(user, client)
    await client.query('COMMIT')
    transactionOpen = false
    return { user, session }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueTokenPair,
  refreshTokenPair,
  ACCESS_EXPIRES_SEC,
}
