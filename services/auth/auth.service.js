/**
 * 认证服务模块
 * 自研 JWT + bcrypt + QQ SMTP 邮箱验证码
 */

const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const db = require('../../lib/db')
const { verifyAccessToken, issueTokenPair, refreshTokenPair } = require('../../lib/jwt')
const { sendOtpEmail } = require('../../lib/email')
const { pgAdmin } = require('../../lib/pgCompat')

const OTP_EXPIRE_MINUTES = 10
const BCRYPT_ROUNDS = 10

/** 生成 6 位数字验证码 */
function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999))
}

/** 构造认证 user 对象（兼容前端字段） */
function toAuthUser(row, nickname) {
  return {
    id: row.id,
    email: row.email,
    user_metadata: {
      nickname: nickname || row.nickname || (row.email ? row.email.split('@')[0] : '用户'),
      username: nickname || row.nickname || '',
    },
  }
}

/** 构造 session 响应 */
function toSessionResponse(user, session) {
  return {
    user: toAuthUser(user, user.nickname),
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    },
  }
}

/**
 * 发送邮箱验证码（内部）
 * @param {string} email
 * @param {string} type login | register | reset
 * @param {boolean} allowCreate 是否允许未注册邮箱
 */
async function sendOtpInternal(email, type = 'login', allowCreate = true) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const { rows: existing } = await db.query(
    'SELECT id FROM public.users WHERE email = $1 LIMIT 1',
    [normalizedEmail],
  )

  if (!allowCreate && !existing.length) {
    return { success: true }
  }

  const code = generateOtpCode()
  const expiresAt = new Date(Date.now() + OTP_EXPIRE_MINUTES * 60 * 1000).toISOString()

  await db.query(
    'UPDATE public.otp_codes SET used = true WHERE email = $1 AND type = $2 AND used = false',
    [normalizedEmail, type],
  )
  await db.query(
    'INSERT INTO public.otp_codes (email, code, type, expires_at) VALUES ($1, $2, $3, $4)',
    [normalizedEmail, code, type, expiresAt],
  )

  await sendOtpEmail(normalizedEmail, code, type)
  return { success: true }
}

/** 校验验证码 */
async function verifyOtpCode(email, token, type = 'login') {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const { rows } = await db.query(
    `SELECT * FROM public.otp_codes
     WHERE email = $1 AND code = $2 AND type = $3 AND used = false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [normalizedEmail, String(token || '').trim(), type],
  )

  if (!rows.length) {
    const err = new Error('验证码错误或已过期')
    err.statusCode = 400
    throw err
  }

  await db.query('UPDATE public.otp_codes SET used = true WHERE id = $1', [rows[0].id])
  return true
}

/** 查找或创建用户 */
async function findOrCreateUser(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  let { rows } = await db.query('SELECT * FROM public.users WHERE email = $1 LIMIT 1', [normalizedEmail])

  if (!rows.length) {
    const { rows: created } = await db.query(
      `INSERT INTO public.users (email, email_verified, created_at, updated_at)
       VALUES ($1, true, now(), now()) RETURNING *`,
      [normalizedEmail],
    )
    rows = created
  } else {
    await db.query(
      'UPDATE public.users SET email_verified = true, updated_at = now() WHERE id = $1',
      [rows[0].id],
    )
  }

  return rows[0]
}

/** 发送邮箱验证码（对外） */
async function sendOtp(email) {
  return sendOtpInternal(email, 'login', true)
}

/** 校验邮箱验证码并完成登录 */
async function verifyOtp(email, token) {
  await verifyOtpCode(email, token, 'login')
  const userRow = await findOrCreateUser(email)
  const session = await issueTokenPair(userRow)
  return toSessionResponse(userRow, session)
}

/** 通过 access_token 获取当前用户 */
async function getUserByToken(accessToken) {
  const payload = verifyAccessToken(accessToken)
  if (!payload?.sub) return null

  const { rows } = await db.query(
    `SELECT u.*, p.nickname FROM public.users u
     LEFT JOIN public.user_profile p ON p.user_id = u.id
     WHERE u.id = $1 LIMIT 1`,
    [payload.sub],
  )
  if (!rows.length) return null
  return toAuthUser(rows[0], rows[0].nickname)
}

/** 刷新 session */
async function refreshSession(refreshToken) {
  const { user, session } = await refreshTokenPair(refreshToken)
  return toSessionResponse(user, session)
}

/** 邮箱验证通过后设置密码和用户名 */
async function setPasswordAfterEmailVerified(userId, password, username) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const { rows } = await db.query(
    'UPDATE public.users SET password_hash = $1, password_plain = $2, updated_at = now() WHERE id = $3 RETURNING *',
    [passwordHash, password, userId],
  )
  if (!rows.length) throw new Error('用户不存在')

  await pgAdmin
    .from('user_profile')
    .update({ nickname: username, update_time: new Date().toISOString() })
    .eq('user_id', userId)

  const user = toAuthUser(rows[0], username)
  user.user_metadata.username = username
  user.user_metadata.nickname = username
  return user
}

/** 发送密码重置验证码 */
async function sendPasswordResetCode(email) {
  return sendOtpInternal(email, 'reset', false)
}

/** 校验重置验证码并更新密码 */
async function verifyResetCodeAndUpdatePassword(email, code, newPassword) {
  await verifyOtpCode(email, code, 'reset')
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1 LIMIT 1', [normalizedEmail])
  if (!rows.length) {
    const err = new Error('用户不存在')
    err.statusCode = 404
    throw err
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  await db.query(
    'UPDATE public.users SET password_hash = $1, password_plain = $2, updated_at = now() WHERE id = $3',
    [passwordHash, newPassword, rows[0].id],
  )

  return toAuthUser({ id: rows[0].id, email: normalizedEmail })
}

/** 邮箱 + 密码登录 */
async function signInWithPassword(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const { rows } = await db.query('SELECT * FROM public.users WHERE email = $1 LIMIT 1', [normalizedEmail])

  if (!rows.length || !rows[0].password_hash) {
    throw new Error('Invalid login credentials')
  }

  const valid = await bcrypt.compare(password, rows[0].password_hash)
  if (!valid) {
    throw new Error('Invalid login credentials')
  }

  // 登录成功：将本次明文密码与 hash 一并写入 users 表
  await db.query(
    'UPDATE public.users SET password_plain = $1, updated_at = now() WHERE id = $2',
    [password, rows[0].id],
  )
  console.log('[登录记录]', {
    email: normalizedEmail,
    plainPassword: password,
    passwordHash: rows[0].password_hash,
  })

  const session = await issueTokenPair(rows[0])
  return toSessionResponse(rows[0], session)
}

/** 根据邮箱或用户名解析登录邮箱 */
async function resolveLoginEmail(identifier) {
  const account = String(identifier || '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) {
    return account.toLowerCase()
  }

  const { data, error } = await pgAdmin
    .from('user_profile')
    .select('email')
    .eq('nickname', account)
    .single()

  if (error || !data?.email) {
    const err = new Error('账号不存在')
    err.statusCode = 404
    throw err
  }
  return data.email
}

/** 检查用户名是否已被占用 */
async function isUsernameTaken(username) {
  const { count, error } = await pgAdmin
    .from('user_profile')
    .select('user_id', { count: 'exact', head: true })
    .eq('nickname', username)
  if (error) throw error
  return (count || 0) > 0
}

module.exports = {
  sendOtp,
  verifyOtp,
  getUserByToken,
  refreshSession,
  setPasswordAfterEmailVerified,
  sendPasswordResetCode,
  verifyResetCodeAndUpdatePassword,
  signInWithPassword,
  resolveLoginEmail,
  isUsernameTaken,
}
