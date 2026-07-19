/**
 * 登录用户自助资料：查询 / 改昵称 / 旧密码改密
 */

const bcrypt = require('bcryptjs')
const db = require('../../lib/db')
const { issueTokenPair } = require('../../lib/jwt')
const userRepo = require('../../repositories/user.repository')
const { getUserProfile } = require('../user_profile_service')

const BCRYPT_ROUNDS = 10
const NICKNAME_MAX_LENGTH = 32
const PASSWORD_MIN_LENGTH = 6
const PASSWORD_MAX_LENGTH = 72

function createError(message, statusCode = 400, code = '') {
  return Object.assign(new Error(message), { statusCode, code })
}

/** 组装前端账户资料（不含敏感字段） */
async function getMyProfile(userId) {
  const profile = await getUserProfile(userId)
  if (!profile) {
    throw createError('用户不存在', 404, 'USER_NOT_FOUND')
  }
  const { rows } = await db.query(
    `SELECT account, email, email_verified, session_version
     FROM public.users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  )
  const user = rows[0] || {}
  const emailBound = Boolean(user.email && user.email_verified === true)
  return {
    user_id: userId,
    account: user.account || '',
    email: user.email || profile.email || '',
    email_verified: emailBound,
    email_bound: emailBound,
    nickname: profile.nickname || '',
    role: profile.role,
    status: profile.status,
  }
}

/**
 * 更新昵称（仅允许改 nickname）
 * @param {string} userId
 * @param {{ nickname?: string }} payload
 */
async function updateMyProfile(userId, payload = {}) {
  const nickname = String(payload.nickname ?? '').trim()
  if (!nickname) {
    throw createError('昵称不能为空', 400, 'NICKNAME_REQUIRED')
  }
  if (nickname.length > NICKNAME_MAX_LENGTH) {
    throw createError(`昵称不能超过 ${NICKNAME_MAX_LENGTH} 个字符`, 400, 'NICKNAME_TOO_LONG')
  }

  const { error } = await userRepo.updateUser(userId, {
    nickname,
    update_time: new Date().toISOString(),
  })
  if (error) {
    throw createError(`更新资料失败：${error.message}`, 500)
  }
  return getMyProfile(userId)
}

/**
 * 使用旧密码修改密码；成功后撤销旧会话并签发新令牌。
 * @returns {Promise<{ profile: object, session: { access_token, refresh_token, expires_at } }>}
 */
async function changeMyPassword(userId, oldPassword, newPassword) {
  const current = String(oldPassword || '')
  const next = String(newPassword || '')
  if (!current) {
    throw createError('请输入当前密码', 400, 'OLD_PASSWORD_REQUIRED')
  }
  if (next.length < PASSWORD_MIN_LENGTH || next.length > PASSWORD_MAX_LENGTH) {
    throw createError(
      `新密码长度需在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位之间`,
      400,
      'PASSWORD_LENGTH_INVALID',
    )
  }
  if (current === next) {
    throw createError('新密码不能与当前密码相同', 400, 'PASSWORD_UNCHANGED')
  }

  const { rows } = await db.query(
    `SELECT u.id, u.account, u.email, u.email_verified, u.password_hash, u.session_version, p.nickname
     FROM public.users u
     LEFT JOIN public.user_profile p ON p.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  )
  const user = rows[0]
  if (!user) {
    throw createError('用户不存在', 404, 'USER_NOT_FOUND')
  }
  if (!user.password_hash || !(await bcrypt.compare(current, user.password_hash))) {
    throw createError('当前密码不正确', 400, 'OLD_PASSWORD_INVALID')
  }

  const passwordHash = await bcrypt.hash(next, BCRYPT_ROUNDS)
  const client = await db.getPool().connect()
  let transactionOpen = false
  let updatedUser = null
  try {
    await client.query('BEGIN')
    transactionOpen = true
    // 改密后递增会话版本并清空 refresh，防止旧设备继续刷新登录
    const { rows: updatedRows } = await client.query(
      `UPDATE public.users
       SET password_hash = $1, password_plain = NULL,
           session_version = session_version + 1, updated_at = now()
       WHERE id = $2
       RETURNING id, account, email, email_verified, session_version`,
      [passwordHash, userId],
    )
    await client.query('DELETE FROM public.refresh_tokens WHERE user_id = $1', [userId])
    updatedUser = updatedRows[0]
    await client.query('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  const sessionUser = {
    id: updatedUser.id,
    account: updatedUser.account,
    email: updatedUser.email,
    email_verified: updatedUser.email_verified === true,
    session_version: Number(updatedUser.session_version || 0),
    nickname: user.nickname,
  }
  const session = await issueTokenPair(sessionUser)
  const profile = await getMyProfile(userId)
  return { profile, session }
}

module.exports = {
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  NICKNAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
}
