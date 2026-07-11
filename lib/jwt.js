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
  return jwt.sign({ sub: user.id, email: user.email }, settings.JWT_SECRET, {
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

async function issueTokenPair(user) {
  const accessToken = signAccessToken(user)
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_EXPIRES_SEC
  const refreshExpires = new Date(Date.now() + REFRESH_EXPIRES_SEC * 1000).toISOString()

  await db.query(
    'INSERT INTO public.refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, hashToken(refreshToken), refreshExpires],
  )

  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt }
}

async function refreshTokenPair(refreshToken) {
  const tokenHash = hashToken(refreshToken)
  const { rows } = await db.query(
    `SELECT rt.*, u.id, u.email FROM public.refresh_tokens rt
     JOIN public.users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.expires_at > now() LIMIT 1`,
    [tokenHash],
  )
  if (!rows.length) {
    const err = new Error('刷新令牌无效或已过期')
    err.statusCode = 401
    throw err
  }

  await db.query('DELETE FROM public.refresh_tokens WHERE token_hash = $1', [tokenHash])
  const user = { id: rows[0].id, email: rows[0].email }
  const session = await issueTokenPair(user)
  return { user, session }
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueTokenPair,
  refreshTokenPair,
  ACCESS_EXPIRES_SEC,
}
