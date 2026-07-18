/**
 * 认证路由模块
 * 提供随机账号注册、账号/邮箱登录、令牌刷新、密码重置和登录后邮箱绑定。
 */

const express = require('express')
const { body, validationResult } = require('express-validator')
const {
  sendOtp,
  verifyOtp,
  registerGeneratedAccount,
  refreshSession,
  sendPasswordResetCode,
  verifyResetCodeAndUpdatePassword,
  signInWithPassword,
  sendEmailBindCode,
  bindEmail,
} = require('../services/auth/auth.service')
const { ensureUserProfile } = require('../services/user_profile_service')
const inviteService = require('../services/admin/admin.invite.service')
const { authRequired } = require('../middlewares/auth')
const { authLimiter, registerLimiter } = require('../middlewares/rateLimiter')

const router = express.Router()

// 认证入口统一限制单个 IP 的请求频率，随机注册再叠加小时级限制。
router.use(authLimiter)

/** 返回第一条参数校验错误，避免各路由重复拼装响应。 */
function sendValidationError(req, res) {
  const errors = validationResult(req)
  if (errors.isEmpty()) return false
  res.status(400).json({ detail: errors.array()[0].msg })
  return true
}

/** 将业务错误的状态码、机器码和重试时间稳定透传给前端。 */
function sendBusinessError(res, error, fallbackStatus = 400, fallbackMessage = '操作失败') {
  const payload = {
    detail: error.message || fallbackMessage,
  }
  if (error.code) payload.code = error.code
  if (Number.isFinite(error.retry_after)) payload.retry_after = error.retry_after
  return res.status(error.statusCode || fallbackStatus).json(payload)
}

/**
 * 将认证服务与业务资料合并为前端统一会话响应。
 * 随机密码不经过本方法，确保它只在注册成功响应的 credentials 中出现一次。
 */
async function buildSessionPayload(data) {
  const user = data.user
  const session = data.session
  // 随机注册已在单事务中创建 profile；其他登录方式继续执行幂等资料补全。
  const profile = data.profile || await ensureUserProfile(user)
  const account = user.account || user.user_metadata?.username || null
  const emailBound = user.email_bound === true || user.email_verified === true
  const nickname = profile.nickname || user.user_metadata?.nickname || account || '用户'

  return {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    account,
    email: user.email || null,
    email_verified: emailBound,
    email_bound: emailBound,
    nickname,
    user_id: user.id,
    role: profile.role,
    status: profile.status,
    permissions: profile.permissions,
  }
}

/** 发送邮箱验证码；仅已绑定邮箱会真正收到邮件，响应不会泄露账号是否存在。 */
router.post(
  '/sendCode',
  [body('email').isEmail().withMessage('邮箱格式不正确')],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      await sendOtp(req.body.email)
      return res.json({ success: true, message: '如果该邮箱已绑定账号，验证码将很快送达' })
    } catch (error) {
      return sendBusinessError(res, error, 500, '发送验证码失败')
    }
  },
)

/** 使用绑定邮箱验证码登录；禁止通过陌生邮箱自动创建账号。 */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('邮箱格式不正确'),
    body('code').isString().matches(/^\d{6}$/).withMessage('验证码为 6 位数字'),
  ],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      const data = await verifyOtp(req.body.email, req.body.code)
      return res.json(await buildSessionPayload(data))
    } catch (error) {
      return sendBusinessError(res, error, 400, '验证码错误或已过期')
    }
  },
)

/**
 * 创建随机账号和随机密码。
 * 注册不接收邮箱与用户自选密码，生成的明文密码仅在本次响应中返回。
 */
router.post(
  '/register',
  registerLimiter,
  [body('invite_code').optional({ values: 'falsy' }).isString().trim().isLength({ max: 128 }).withMessage('邀请码格式不正确')],
  async (req, res) => {
    if (sendValidationError(req, res)) return

    try {
      const inviteCode = String(req.body.invite_code || '').trim()
      // 先校验邀请码，避免无效邀请创建无法归属的账号。
      const inviteAdminId = inviteCode ? await inviteService.validateInviteCode(inviteCode) : null
      const data = await registerGeneratedAccount()
      const payload = await buildSessionPayload(data)

      if (inviteAdminId) {
        try {
          await inviteService.bindUserRelation(data.user.id, inviteAdminId)
          await inviteService.incrementUsedCount(inviteCode)
        } catch (bindError) {
          // 邀请归属失败不撤销已创建账号，但必须留下可追查日志。
          console.error('[auth] 绑定邀请归属失败：', bindError.message)
        }
      }

      return res.json({
        success: true,
        message: '注册成功，请妥善保存账号和密码',
        ...payload,
        credentials: data.credentials,
      })
    } catch (error) {
      return sendBusinessError(res, error, 500, '注册失败')
    }
  },
)

/** 使用随机账号、已绑定邮箱或历史用户名兼容登录。 */
router.post(
  '/loginPassword',
  [
    body('identifier').optional().isString().trim().notEmpty().withMessage('账号不能为空'),
    body('email').optional().isString().trim().notEmpty().withMessage('账号不能为空'),
    body('password').isString().notEmpty().withMessage('密码不能为空'),
  ],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    const identifier = String(req.body.identifier || req.body.email || '').trim()
    if (!identifier) return res.status(400).json({ detail: '请输入账号或邮箱' })

    try {
      const data = await signInWithPassword(identifier, req.body.password)
      return res.json(await buildSessionPayload(data))
    } catch (error) {
      return sendBusinessError(res, error, 400, '登录失败')
    }
  },
)

/** 使用 refresh_token 轮换一对新令牌，并同步最新身份状态。 */
router.post(
  '/refresh',
  [body('refresh_token').isString().notEmpty().withMessage('refresh_token 不能为空')],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      const data = await refreshSession(req.body.refresh_token)
      return res.json(await buildSessionPayload(data))
    } catch (error) {
      return sendBusinessError(res, error, 401, '刷新令牌无效或已过期')
    }
  },
)

/** 为当前已登录但未绑定邮箱的账号发送绑定验证码。 */
router.post(
  '/email/send-code',
  authRequired,
  [body('email').isEmail().withMessage('邮箱格式不正确')],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      const result = await sendEmailBindCode(req.user.id, req.body.email)
      return res.json({ success: true, message: '验证码已发送，请查收邮箱', ...result })
    } catch (error) {
      return sendBusinessError(res, error, 400, '发送绑定验证码失败')
    }
  },
)

/** 校验验证码并将唯一邮箱绑定到当前账号。 */
router.post(
  '/email/bind',
  authRequired,
  [
    body('email').isEmail().withMessage('邮箱格式不正确'),
    body('code').isString().matches(/^\d{6}$/).withMessage('验证码为 6 位数字'),
  ],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      const user = await bindEmail(req.user.id, req.body.email, req.body.code)
      return res.json({
        success: true,
        message: '邮箱绑定成功',
        account: user.account || null,
        email: user.email,
        email_verified: true,
        email_bound: true,
        user_id: user.id,
      })
    } catch (error) {
      return sendBusinessError(res, error, 400, '邮箱绑定失败')
    }
  },
)

/** 向已绑定邮箱发送密码重置验证码，统一成功响应以防账号枚举。 */
router.post(
  '/resetPassword',
  [body('email').isEmail().withMessage('邮箱格式不正确')],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      await sendPasswordResetCode(req.body.email)
      return res.json({ success: true, message: '如果该邮箱已绑定账号，验证码将很快送达' })
    } catch (error) {
      return sendBusinessError(res, error, 500, '发送验证码失败')
    }
  },
)

/** 校验重置验证码并写入新的不可逆密码哈希。 */
router.post(
  '/updatePassword',
  [
    body('email').isEmail().withMessage('邮箱格式不正确'),
    body('code').isString().matches(/^\d{6}$/).withMessage('验证码为 6 位数字'),
    body('password').isString().isLength({ min: 6, max: 72 }).withMessage('密码长度需在 6-72 位之间'),
  ],
  async (req, res) => {
    if (sendValidationError(req, res)) return
    try {
      await verifyResetCodeAndUpdatePassword(req.body.email, req.body.code, req.body.password)
      return res.json({ success: true, message: '密码重置成功，请使用新密码登录' })
    } catch (error) {
      return sendBusinessError(res, error, 400, '重置密码失败')
    }
  },
)

module.exports = router
