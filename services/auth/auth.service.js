/**
 * 认证服务模块
 * 自研 JWT + bcrypt + SMTP 邮箱验证码，支持随机账号注册与后置邮箱绑定。
 */

const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const db = require('../../lib/db')
const { verifyAccessToken, issueTokenPair, refreshTokenPair } = require('../../lib/jwt')
const { sendOtpEmail } = require('../../lib/email')
const { getRolePermissions } = require('../../utils/permissions')

const OTP_EXPIRE_MINUTES = 10
const OTP_MAX_ATTEMPTS = 5
const BIND_EMAIL_COOLDOWN_SECONDS = 60
const BIND_EMAIL_DAILY_LIMIT = 10
const BCRYPT_ROUNDS = 10
const ACCOUNT_CREATE_RETRIES = 8
const INITIAL_PASSWORD_LENGTH = 14

/** 钱包金额统一保留四位小数，与现有钱包服务和 numeric 字段保持一致。 */
function roundMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000
}

/** 构造带状态码和机器码的认证错误，供路由稳定识别。 */
function createAuthError(message, statusCode = 400, code = '', extra = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...extra })
}

/** 邮箱统一转为小写，避免大小写导致重复绑定。 */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

/** 生成 6 位数字验证码。 */
function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000))
}

/** 生成小写随机账号，最终唯一性由数据库索引保证。 */
function generateAccount() {
  return `ai${crypto.randomBytes(6).toString('hex')}`
}

/** 从指定字符表中安全抽取一个字符。 */
function randomCharacter(alphabet) {
  return alphabet[crypto.randomInt(0, alphabet.length)]
}

/**
 * 生成便于复制且包含大小写和数字的初始密码。
 * 密码仅在注册响应中返回一次，数据库只保存 bcrypt 哈希。
 */
function generateInitialPassword(length = INITIAL_PASSWORD_LENGTH) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digits = '23456789'
  const alphabet = `${upper}${lower}${digits}`
  const chars = [randomCharacter(upper), randomCharacter(lower), randomCharacter(digits)]

  while (chars.length < Math.max(length, 12)) {
    chars.push(randomCharacter(alphabet))
  }

  // 使用加密随机数洗牌，避免固定的复杂度字符位置泄露模式。
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1)
    ;[chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]]
  }
  return chars.join('')
}

/** 判断数据库用户是否已经完成邮箱绑定。 */
function isEmailBound(row) {
  return Boolean(row?.email && row?.email_verified === true)
}

/** 构造认证 user 对象，并保留邮箱绑定真实状态。 */
function toAuthUser(row, nickname) {
  const email = row.email || null
  const account = row.account || null
  const displayName = nickname || row.nickname || account || (email ? email.split('@')[0] : '用户')
  return {
    id: row.id,
    account,
    email,
    email_verified: isEmailBound(row),
    email_bound: isEmailBound(row),
    session_version: Number(row.session_version || 0),
    user_metadata: {
      nickname: displayName,
      username: account || displayName,
    },
  }
}

/** 构造 session 响应。 */
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

/** 查询已经绑定并验证邮箱的用户。 */
async function findBoundUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email)
  const { rows } = await db.query(
    `SELECT u.*, p.nickname
     FROM public.users u
     LEFT JOIN public.user_profile p ON p.user_id = u.id
     WHERE LOWER(u.email) = LOWER($1) AND u.email_verified = true
     LIMIT 1`,
    [normalizedEmail],
  )
  return rows[0] || null
}

/** 为已存在用户签发登录或重置验证码。 */
async function issueOtpForUser(user, type) {
  const normalizedEmail = normalizeEmail(user.email)
  const code = generateOtpCode()
  const expiresAt = new Date(Date.now() + OTP_EXPIRE_MINUTES * 60 * 1000).toISOString()
  const client = await db.getPool().connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    // 同一用户同类验证码串行发送，并统一执行 60 秒冷却和 24 小时上限。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp:${type}:${user.id}`])
    const { rows: limitRows } = await client.query(
      `SELECT MAX(created_at) AS last_sent_at, COUNT(*)::int AS sent_count
       FROM public.otp_codes
       WHERE user_id = $1 AND type = $2
         AND created_at >= now() - interval '24 hours'`,
      [user.id, type],
    )
    const limitInfo = limitRows[0] || {}
    if (limitInfo.last_sent_at) {
      const elapsedMs = Date.now() - new Date(limitInfo.last_sent_at).getTime()
      if (elapsedMs < BIND_EMAIL_COOLDOWN_SECONDS * 1000) {
        const retryAfter = Math.max(1, Math.ceil((BIND_EMAIL_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000))
        throw createAuthError('验证码发送过于频繁，请稍后再试', 429, 'OTP_SEND_TOO_FREQUENT', {
          retry_after: retryAfter,
        })
      }
    }
    if (Number(limitInfo.sent_count || 0) >= BIND_EMAIL_DAILY_LIMIT) {
      throw createAuthError('今日验证码发送次数已达上限，请明日再试', 429, 'OTP_DAILY_LIMIT_EXCEEDED')
    }

    const { rows: insertedRows } = await client.query(
      `INSERT INTO public.otp_codes (user_id, email, code, type, expires_at, attempt_count)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id`,
      [user.id, normalizedEmail, code, type, expiresAt],
    )
    // SMTP 失败会回滚新挑战，旧验证码继续有效；成功后再失效旧挑战。
    await sendOtpEmail(normalizedEmail, code, type)
    await client.query(
      `UPDATE public.otp_codes
       SET used = true
       WHERE type = $1 AND used = false AND id <> $2
         AND (user_id = $3 OR LOWER(email) = LOWER($4))`,
      [type, insertedRows[0].id, user.id, normalizedEmail],
    )
    await client.query('COMMIT')
    transactionOpen = false
    return { success: true, retry_after: BIND_EMAIL_COOLDOWN_SECONDS }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * 校验验证码并累计错误次数。
 * strictUser=true 时验证码必须精确属于当前登录用户，用于邮箱绑定。
 */
async function verifyOtpCode(email, token, type = 'login', options = {}) {
  const normalizedEmail = normalizeEmail(email)
  const suppliedCode = String(token || '').trim()
  const userId = options.userId || null
  const strictUser = options.strictUser === true
  const client = await db.getPool().connect()
  let transactionOpen = false

  try {
    await client.query('BEGIN')
    transactionOpen = true

    const params = [normalizedEmail, type]
    let userClause = ''
    if (userId) {
      params.push(userId)
      userClause = strictUser
        ? ` AND user_id = $${params.length}`
        : ` AND (user_id = $${params.length} OR user_id IS NULL)`
    }

    const { rows } = await client.query(
      `SELECT * FROM public.otp_codes
       WHERE LOWER(email) = LOWER($1)
         AND type = $2
         AND used = false
         AND expires_at > now()
         ${userClause}
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      params,
    )

    if (!rows.length) {
      throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
    }

    const challenge = rows[0]
    if (Number(challenge.attempt_count || 0) >= OTP_MAX_ATTEMPTS) {
      await client.query('UPDATE public.otp_codes SET used = true WHERE id = $1', [challenge.id])
      throw createAuthError('验证码错误次数过多，请重新获取', 429, 'OTP_ATTEMPTS_EXCEEDED')
    }

    const expectedBuffer = Buffer.from(String(challenge.code || ''))
    const suppliedBuffer = Buffer.from(suppliedCode)
    const codeMatches =
      expectedBuffer.length === suppliedBuffer.length &&
      expectedBuffer.length > 0 &&
      crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)

    if (!codeMatches) {
      const nextAttemptCount = Number(challenge.attempt_count || 0) + 1
      const exhausted = nextAttemptCount >= OTP_MAX_ATTEMPTS
      await client.query(
        'UPDATE public.otp_codes SET attempt_count = $1, used = $2 WHERE id = $3',
        [nextAttemptCount, exhausted, challenge.id],
      )
      await client.query('COMMIT')
      transactionOpen = false
      if (exhausted) {
        throw createAuthError('验证码错误次数过多，请重新获取', 429, 'OTP_ATTEMPTS_EXCEEDED')
      }
      throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
    }

    await client.query('UPDATE public.otp_codes SET used = true WHERE id = $1', [challenge.id])
    await client.query('COMMIT')
    transactionOpen = false
    return true
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** 发送邮箱验证码；不存在或未绑定的邮箱统一返回成功，避免枚举账号。 */
async function sendOtp(email) {
  const user = await findBoundUserByEmail(email)
  if (!user) return { success: true }
  return issueOtpForUser(user, 'login')
}

/** 校验邮箱验证码并完成既有账号登录，禁止再由邮箱自动创建账号。 */
async function verifyOtp(email, token) {
  const userRow = await findBoundUserByEmail(email)
  if (!userRow) {
    throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
  }
  await verifyOtpCode(email, token, 'login', { userId: userRow.id })
  const session = await issueTokenPair(userRow)
  return toSessionResponse(userRow, session)
}

/**
 * 创建随机账号和随机密码，账号唯一冲突时在数据库约束保护下重试。
 * 用户、资料、注册赠金钱包和首对令牌使用同一事务，任何失败都不会留下未返回凭据的孤儿账号。
 */
async function registerGeneratedAccount() {
  const password = generateInitialPassword()
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

  for (let attempt = 0; attempt < ACCOUNT_CREATE_RETRIES; attempt += 1) {
    const account = generateAccount()
    const client = await db.getPool().connect()
    let transactionOpen = false
    try {
      await client.query('BEGIN')
      transactionOpen = true
      const { rows } = await client.query(
        `INSERT INTO public.users (
          account, email, password_hash, email_verified, created_at, updated_at
        ) VALUES ($1, NULL, $2, false, now(), now())
        RETURNING *`,
        [account, passwordHash],
      )
      const userRow = rows[0]
      await client.query(
        `INSERT INTO public.user_profile (
          user_id, email, nickname, role, status, create_time, update_time
        ) VALUES ($1, NULL, $2, 'USER', 'ACTIVE', now(), now())`,
        [userRow.id, account],
      )

      // 未验证邮箱的随机账号只创建零余额钱包，防止批量注册消耗注册赠金额度。
      await client.query(
        `INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
         VALUES ($1, 0, 0, now())`,
        [userRow.id],
      )

      const session = await issueTokenPair(userRow, client)
      await client.query('COMMIT')
      transactionOpen = false
      return {
        ...toSessionResponse(userRow, session),
        profile: {
          user_id: userRow.id,
          email: null,
          nickname: account,
          role: 'USER',
          status: 'ACTIVE',
          permissions: getRolePermissions('USER'),
        },
        credentials: { account, password },
      }
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK')
      if (error.code === '23505') continue
      throw error
    } finally {
      client.release()
    }
  }

  throw createAuthError('生成唯一账号失败，请稍后重试', 503, 'ACCOUNT_GENERATION_FAILED')
}

/** 通过 access_token 获取当前用户，邮箱状态始终以数据库最新值为准。 */
async function getUserByToken(accessToken) {
  const payload = verifyAccessToken(accessToken)
  if (!payload?.sub) return null

  const { rows } = await db.query(
    `SELECT u.*, p.nickname
     FROM public.users u
     LEFT JOIN public.user_profile p ON p.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [payload.sub],
  )
  if (!rows.length) return null
  // 密码重置会递增会话版本，旧 access token 即使尚未到期也必须立即失效。
  if (Number(payload.ver || 0) !== Number(rows[0].session_version || 0)) return null
  return toAuthUser(rows[0], rows[0].nickname)
}

/** 刷新 session，并返回完整账号与邮箱绑定状态。 */
async function refreshSession(refreshToken) {
  const { user, session } = await refreshTokenPair(refreshToken)
  // 刷新令牌已在事务中完成轮换，响应组装不得再依赖可能失败的额外数据库写入。
  return {
    ...toSessionResponse(user, session),
    profile: {
      user_id: user.id,
      email: user.email || null,
      nickname: user.nickname || user.account || '用户',
      role: user.role || 'USER',
      status: user.status || 'ACTIVE',
      permissions: getRolePermissions(user.role || 'USER'),
    },
  }
}

/** 发送密码重置验证码；仅已绑定邮箱可以收到邮件。 */
async function sendPasswordResetCode(email) {
  const user = await findBoundUserByEmail(email)
  if (!user) return { success: true }
  return issueOtpForUser(user, 'reset')
}

/** 校验重置验证码并更新 bcrypt 密码哈希，不再保存可逆密码。 */
async function verifyResetCodeAndUpdatePassword(email, code, newPassword) {
  const user = await findBoundUserByEmail(email)
  if (!user) {
    throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
  }
  await verifyOtpCode(email, code, 'reset', { userId: user.id })
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  const client = await db.getPool().connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    // 新密码生效时同时撤销 refresh token，并递增版本让现有 access token 失效。
    await client.query(
      `UPDATE public.users
       SET password_hash = $1, password_plain = NULL,
           session_version = session_version + 1, updated_at = now()
       WHERE id = $2`,
      [passwordHash, user.id],
    )
    await client.query('DELETE FROM public.refresh_tokens WHERE user_id = $1', [user.id])
    await client.query('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return toAuthUser(user, user.nickname)
}

/** 按随机账号、绑定邮箱或旧昵称兼容查找密码登录用户。 */
async function findPasswordLoginUser(identifier) {
  const account = String(identifier || '').trim()
  const { rows } = await db.query(
    `SELECT u.*, p.nickname
     FROM public.users u
     LEFT JOIN public.user_profile p ON p.user_id = u.id
     WHERE LOWER(u.account) = LOWER($1)
        OR LOWER(u.email) = LOWER($1)
        OR (u.account IS NULL AND p.nickname = $1)
     ORDER BY CASE
       WHEN LOWER(u.account) = LOWER($1) THEN 0
       WHEN LOWER(u.email) = LOWER($1) THEN 1
       ELSE 2
     END, u.created_at ASC
     LIMIT 1`,
    [account],
  )
  return rows[0] || null
}

/** 账号、邮箱或旧昵称 + 密码登录。 */
async function signInWithPassword(identifier, password) {
  const user = await findPasswordLoginUser(identifier)
  if (!user) {
    throw createAuthError('账号不存在', 404, 'ACCOUNT_NOT_FOUND')
  }
  if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    throw createAuthError('账号或密码错误', 401, 'INVALID_CREDENTIALS')
  }

  const session = await issueTokenPair(user)
  return toSessionResponse(user, session)
}

/** 检查待绑定邮箱是否已归属其他账号。 */
async function assertEmailAvailable(client, userId, email) {
  const { rows } = await client.query(
    `SELECT id FROM public.users
     WHERE LOWER(email) = LOWER($1) AND id <> $2
     LIMIT 1`,
    [email, userId],
  )
  if (rows.length) {
    throw createAuthError('该邮箱已绑定其他账号', 409, 'EMAIL_IN_USE')
  }
}

/**
 * 首次邮箱验证后原子发放注册赠金。
 * 用户钱包时间戳和行锁提供幂等性；超管扣款、双方流水与用户入账和邮箱绑定共同提交。
 */
async function grantRegisterGiftAfterEmailBinding(client, userId) {
  await client.query(
    `INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
     VALUES ($1, 0, 0, now())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  )
  const { rows: userWalletRows } = await client.query(
    `SELECT balance, register_gift_granted_at
     FROM public.user_wallet
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  )
  const userWallet = userWalletRows[0]
  if (userWallet?.register_gift_granted_at) return 0

  const { rows: configRows } = await client.query(
    `SELECT config_value
     FROM public.system_config
     WHERE config_key = 'register_gift_amount'
     LIMIT 1`,
  )
  const configuredGift = Math.max(0, roundMoney(configRows[0]?.config_value?.amount ?? 10))
  const { rows: adminRows } = await client.query(
    `SELECT user_id
     FROM public.user_profile
     WHERE role = 'SUPER_ADMIN'
     ORDER BY create_time ASC
     LIMIT 1`,
  )

  let actualGift = 0
  let superAdminId = null
  if (adminRows.length && configuredGift > 0) {
    superAdminId = adminRows[0].user_id
    await client.query(
      `INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
       VALUES ($1, 0, 0, now())
       ON CONFLICT (user_id) DO NOTHING`,
      [superAdminId],
    )
    const { rows: adminWalletRows } = await client.query(
      'SELECT balance FROM public.user_wallet WHERE user_id = $1 FOR UPDATE',
      [superAdminId],
    )
    const adminBalance = Math.max(0, roundMoney(adminWalletRows[0]?.balance || 0))
    actualGift = roundMoney(Math.min(configuredGift, adminBalance))

    if (actualGift > 0) {
      const nextAdminBalance = roundMoney(adminBalance - actualGift)
      await client.query(
        'UPDATE public.user_wallet SET balance = $1, update_time = now() WHERE user_id = $2',
        [nextAdminBalance, superAdminId],
      )
      await client.query(
        `INSERT INTO public.balance_ledger (
          user_id, type, amount, balance_after, remark, paid_amount, create_time
        ) VALUES ($1, 'REGISTER_GIFT', $2, $3, $4, 0, now())`,
        [superAdminId, -actualGift, nextAdminBalance, `新用户邮箱验证赠送扣减 ¥${actualGift}`],
      )
    }
  }

  const nextUserBalance = roundMoney(Number(userWallet?.balance || 0) + actualGift)
  await client.query(
    `UPDATE public.user_wallet
     SET balance = $1, register_gift_granted_at = now(), update_time = now()
     WHERE user_id = $2`,
    [nextUserBalance, userId],
  )
  if (actualGift > 0) {
    await client.query(
      `INSERT INTO public.balance_ledger (
        user_id, type, amount, balance_after, remark, operator_id, paid_amount, create_time
      ) VALUES ($1, 'REGISTER_GIFT', $2, $3, '首次邮箱验证赠送', $4, 0, now())`,
      [userId, actualGift, nextUserBalance, superAdminId],
    )
  }
  return actualGift
}

/**
 * 发送绑定邮箱验证码。
 * 数据库锁与统计共同保证 60 秒冷却、每邮箱和每用户 24 小时最多 10 次。
 */
async function sendEmailBindCode(userId, email) {
  const normalizedEmail = normalizeEmail(email)
  const client = await db.getPool().connect()
  let transactionOpen = false
  let challengeId = null
  let code = ''

  try {
    await client.query('BEGIN')
    transactionOpen = true
    // 用户锁防止同一账号并行更换目标邮箱，邮箱锁防止多个账号抢占同一邮箱。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bind-user:${userId}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bind-email:${normalizedEmail}`])

    const { rows: userRows } = await client.query(
      'SELECT * FROM public.users WHERE id = $1 FOR UPDATE',
      [userId],
    )
    const user = userRows[0]
    if (!user) throw createAuthError('用户不存在', 404, 'ACCOUNT_NOT_FOUND')
    if (isEmailBound(user)) {
      throw createAuthError('当前账号已绑定邮箱', 409, 'EMAIL_ALREADY_BOUND')
    }
    await assertEmailAvailable(client, userId, normalizedEmail)

    const { rows: limitRows } = await client.query(
      `SELECT
         MAX(created_at) AS last_sent_at,
         COUNT(*) FILTER (WHERE LOWER(email) = LOWER($2))::int AS email_count,
         COUNT(*) FILTER (WHERE user_id = $1)::int AS user_count
       FROM public.otp_codes
       WHERE type = 'bind_email'
         AND created_at >= now() - interval '24 hours'
         AND (LOWER(email) = LOWER($2) OR user_id = $1)`,
      [userId, normalizedEmail],
    )
    const limitInfo = limitRows[0] || {}
    if (limitInfo.last_sent_at) {
      const elapsedMs = Date.now() - new Date(limitInfo.last_sent_at).getTime()
      if (elapsedMs < BIND_EMAIL_COOLDOWN_SECONDS * 1000) {
        const retryAfter = Math.max(1, Math.ceil((BIND_EMAIL_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000))
        throw createAuthError('验证码发送过于频繁，请稍后再试', 429, 'OTP_SEND_TOO_FREQUENT', {
          retry_after: retryAfter,
        })
      }
    }
    if (
      Number(limitInfo.email_count || 0) >= BIND_EMAIL_DAILY_LIMIT ||
      Number(limitInfo.user_count || 0) >= BIND_EMAIL_DAILY_LIMIT
    ) {
      throw createAuthError('今日验证码发送次数已达上限，请明日再试', 429, 'OTP_DAILY_LIMIT_EXCEEDED')
    }

    code = generateOtpCode()
    const expiresAt = new Date(Date.now() + OTP_EXPIRE_MINUTES * 60 * 1000).toISOString()
    const { rows: insertedRows } = await client.query(
      `INSERT INTO public.otp_codes (
        user_id, email, code, type, expires_at, used, attempt_count
      ) VALUES ($1, $2, $3, 'bind_email', $4, false, 0)
      RETURNING id`,
      [userId, normalizedEmail, code, expiresAt],
    )
    challengeId = insertedRows[0].id
    // SMTP 失败会回滚整个挑战，旧验证码继续有效；发送成功后才在同一事务内作废旧码。
    await sendOtpEmail(normalizedEmail, code, 'bind_email')
    await client.query(
      `UPDATE public.otp_codes
       SET used = true
       WHERE type = 'bind_email' AND used = false AND id <> $3
         AND (user_id = $1 OR LOWER(email) = LOWER($2))`,
      [userId, normalizedEmail, challengeId],
    )
    await client.query('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return { success: true, retry_after: BIND_EMAIL_COOLDOWN_SECONDS }
}

/** 验证绑定码并在同一事务中写入 users 与 user_profile。 */
async function bindEmail(userId, email, token) {
  const normalizedEmail = normalizeEmail(email)
  const suppliedCode = String(token || '').trim()
  const client = await db.getPool().connect()
  let transactionOpen = false

  try {
    await client.query('BEGIN')
    transactionOpen = true
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bind-user:${userId}`])
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bind-email:${normalizedEmail}`])

    const { rows: userRows } = await client.query(
      'SELECT * FROM public.users WHERE id = $1 FOR UPDATE',
      [userId],
    )
    const currentUser = userRows[0]
    if (!currentUser) throw createAuthError('用户不存在', 404, 'ACCOUNT_NOT_FOUND')

    if (isEmailBound(currentUser)) {
      if (normalizeEmail(currentUser.email) !== normalizedEmail) {
        throw createAuthError('当前账号已绑定邮箱', 409, 'EMAIL_ALREADY_BOUND')
      }
      const { rows } = await client.query(
        `SELECT u.*, p.nickname
         FROM public.users u
         LEFT JOIN public.user_profile p ON p.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      )
      await client.query('COMMIT')
      transactionOpen = false
      return toAuthUser(rows[0], rows[0]?.nickname)
    }

    await assertEmailAvailable(client, userId, normalizedEmail)
    const { rows: challengeRows } = await client.query(
      `SELECT * FROM public.otp_codes
       WHERE user_id = $1
         AND LOWER(email) = LOWER($2)
         AND type = 'bind_email'
         AND used = false
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [userId, normalizedEmail],
    )
    if (!challengeRows.length) {
      throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
    }

    const challenge = challengeRows[0]
    if (Number(challenge.attempt_count || 0) >= OTP_MAX_ATTEMPTS) {
      await client.query('UPDATE public.otp_codes SET used = true WHERE id = $1', [challenge.id])
      throw createAuthError('验证码错误次数过多，请重新获取', 429, 'OTP_ATTEMPTS_EXCEEDED')
    }

    const expectedBuffer = Buffer.from(String(challenge.code || ''))
    const suppliedBuffer = Buffer.from(suppliedCode)
    const codeMatches =
      expectedBuffer.length === suppliedBuffer.length &&
      expectedBuffer.length > 0 &&
      crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)

    if (!codeMatches) {
      const nextAttemptCount = Number(challenge.attempt_count || 0) + 1
      const exhausted = nextAttemptCount >= OTP_MAX_ATTEMPTS
      await client.query(
        'UPDATE public.otp_codes SET attempt_count = $1, used = $2 WHERE id = $3',
        [nextAttemptCount, exhausted, challenge.id],
      )
      await client.query('COMMIT')
      transactionOpen = false
      if (exhausted) {
        throw createAuthError('验证码错误次数过多，请重新获取', 429, 'OTP_ATTEMPTS_EXCEEDED')
      }
      throw createAuthError('验证码错误或已过期', 400, 'OTP_INVALID_OR_EXPIRED')
    }

    await client.query('UPDATE public.otp_codes SET used = true WHERE id = $1', [challenge.id])
    await client.query(
      `UPDATE public.users
       SET email = $1, email_verified = true, updated_at = now()
       WHERE id = $2`,
      [normalizedEmail, userId],
    )
    await client.query(
      `UPDATE public.user_profile
       SET email = $1, update_time = now()
       WHERE user_id = $2`,
      [normalizedEmail, userId],
    )
    await grantRegisterGiftAfterEmailBinding(client, userId)

    const { rows } = await client.query(
      `SELECT u.*, p.nickname
       FROM public.users u
       LEFT JOIN public.user_profile p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    )
    await client.query('COMMIT')
    transactionOpen = false
    return toAuthUser(rows[0], rows[0]?.nickname)
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    if (error.code === '23505') {
      throw createAuthError('该邮箱已绑定其他账号', 409, 'EMAIL_IN_USE')
    }
    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  sendOtp,
  verifyOtp,
  registerGeneratedAccount,
  getUserByToken,
  refreshSession,
  sendPasswordResetCode,
  verifyResetCodeAndUpdatePassword,
  signInWithPassword,
  sendEmailBindCode,
  bindEmail,
}
