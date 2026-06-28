/**
 * 认证路由模块
 * 基于 Supabase Auth 提供完整的认证功能：
 * 1. POST /api/auth/sendCode       - 发送邮箱验证码
 * 2. POST /api/auth/login          - 验证码登录（首次自动注册）
 * 3. POST /api/auth/register       - 邮箱验证码校验通过后设置用户名和密码
 * 4. POST /api/auth/loginPassword  - 用户名/邮箱 + 密码登录
 * 5. POST /api/auth/refresh        - 刷新 token
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  sendOtp,
  verifyOtp,
  refreshSession,
  setPasswordAfterEmailVerified,
  signInWithPassword,
  resolveLoginEmail,
  isUsernameTaken,
} = require('../services/auth_service');
const { ensureUserProfile, getUserProfile } = require('../services/user_profile_service');

const router = express.Router();

/**
 * 发送验证码接口
 */
router.post(
  '/sendCode',
  [body('email').isEmail().withMessage('邮箱格式不正确')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ detail: errors.array()[0].msg });
    }
    try {
      await sendOtp(req.body.email);
      return res.json({ success: true, message: '验证码已发送，请查收邮箱' });
    } catch (e) {
      const msg = e.message || '';
      if (/rate limit/i.test(msg)) {
        return res.status(429).json({
          detail: '邮件发送频率超限，请稍后再试',
        });
      }
      if (/invalid.*email/i.test(msg)) {
        return res.status(400).json({ detail: '邮箱格式不正确' });
      }
      return res.status(500).json({ detail: `发送验证码失败：${msg}` });
    }
  },
);

/**
 * 验证码登录接口
 */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('邮箱格式不正确'),
    body('code').isString().notEmpty().withMessage('验证码不能为空'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ detail: errors.array()[0].msg });
    }
    const { email, code } = req.body;
    try {
      const data = await verifyOtp(email, code);
      const user = data.user;
      const session = data.session;
      const profile = await ensureUserProfile(user);
      const nickname = profile.nickname || (user.user_metadata && user.user_metadata.nickname) || email.split('@')[0];
      return res.json({
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        email: user.email,
        nickname,
        user_id: user.id,
        role: profile.role,
        status: profile.status,
        vip_expire_time: profile.vip_expire_time,
        permissions: profile.permissions,
      });
    } catch (e) {
      return res.status(400).json({ detail: e.message || '验证码错误或已过期' });
    }
  },
);

/**
 * 注册接口
 * 邮箱验证码 + 用户名 + 密码注册
 * 先校验邮箱验证码，再为该邮箱用户设置密码，避免未验证邮箱直接创建可登录账号。
 */
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('邮箱格式不正确'),
    body('code').isString().notEmpty().withMessage('邮箱验证码不能为空'),
    body('password')
      .isString()
      .isLength({ min: 6, max: 72 })
      .withMessage('密码长度需在 6-72 位之间'),
    body('username')
      .isString()
      .trim()
      .isLength({ min: 2, max: 32 })
      .matches(/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/)
      .withMessage('用户名仅支持中英文/数字/下划线/中划线，长度 2-32'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ detail: errors.array()[0].msg });
    }
    const { email, code, password, username } = req.body;
    try {
      if (await isUsernameTaken(username)) {
        return res.status(409).json({ detail: '该用户名已被占用，请更换用户名' });
      }
      // 先校验邮箱验证码，确保注册前邮箱已验证
      const verified = await verifyOtp(email, code);
      const existingProfile = await getUserProfile(verified.user.id);
      if (existingProfile) {
        return res.status(409).json({ detail: '该邮箱已注册，请直接登录' });
      }
      const user = await setPasswordAfterEmailVerified(verified.user.id, password, username);
      const profile = await ensureUserProfile(user);
      return res.json({
        success: true,
        need_verify: false,
        message: '注册成功，邮箱已验证',
        token: verified.session.access_token,
        refresh_token: verified.session.refresh_token,
        expires_at: verified.session.expires_at,
        email: user.email,
        nickname: profile.nickname,
        user_id: user.id,
        role: profile.role,
        status: profile.status,
        vip_expire_time: profile.vip_expire_time,
        permissions: profile.permissions,
      });
    } catch (e) {
      const msg = e.message || '';
      if (/already registered/i.test(msg) || /already been registered/i.test(msg)) {
        return res.status(409).json({ detail: '该邮箱已被注册，请直接登录' });
      }
      if (/token/i.test(msg) || /otp/i.test(msg) || /expired/i.test(msg)) {
        return res.status(400).json({ detail: '邮箱验证码错误或已过期' });
      }
      if (/rate limit/i.test(msg)) {
        return res.status(429).json({ detail: '邮件发送频率超限，请稍后再试' });
      }
      if (/weak password/i.test(msg) || (/password/i.test(msg) && /short/i.test(msg))) {
        return res.status(400).json({ detail: '密码强度不足，请使用更复杂的密码' });
      }
      return res.status(500).json({ detail: `注册失败：${msg}` });
    }
  },
);

/**
 * 用户名/邮箱 + 密码登录接口
 */
router.post(
  '/loginPassword',
  [
    body('identifier').optional().isString().notEmpty().withMessage('账号不能为空'),
    body('email').optional().isString().notEmpty().withMessage('账号不能为空'),
    body('password').isString().notEmpty().withMessage('密码不能为空'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ detail: errors.array()[0].msg });
    }
    const { password } = req.body;
    const identifier = req.body.identifier || req.body.email;
    if (!identifier) {
      return res.status(400).json({ detail: '请输入用户名或邮箱' });
    }
    try {
      const email = await resolveLoginEmail(identifier);
      const data = await signInWithPassword(email, password);
      const user = data.user;
      const session = data.session;
      const profile = await ensureUserProfile(user);
      const nickname =
        profile.nickname ||
        (user.user_metadata && (user.user_metadata.nickname || user.user_metadata.username)) ||
        email.split('@')[0];
      return res.json({
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        email: user.email,
        nickname,
        user_id: user.id,
        role: profile.role,
        status: profile.status,
        vip_expire_time: profile.vip_expire_time,
        permissions: profile.permissions,
      });
    } catch (e) {
      const msg = e.message || '';
      if (e.statusCode === 404) {
        return res.status(404).json({ detail: '用户名或邮箱不存在' });
      }
      if (/invalid login credentials/i.test(msg) || /invalid credentials/i.test(msg)) {
        return res.status(401).json({ detail: '用户名/邮箱或密码错误' });
      }
      if (/email not confirmed/i.test(msg)) {
        return res.status(403).json({ detail: '邮箱尚未验证，请先前往邮箱点击验证链接' });
      }
      return res.status(400).json({ detail: msg || '登录失败' });
    }
  },
);

/**
 * 刷新 token 接口
 */
router.post(
  '/refresh',
  [body('refresh_token').isString().notEmpty().withMessage('refresh_token 不能为空')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ detail: errors.array()[0].msg });
    }
    try {
      const data = await refreshSession(req.body.refresh_token);
      const session = data.session;
      const profile = data.user ? await ensureUserProfile(data.user) : null;
      return res.json({
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        role: profile ? profile.role : undefined,
        status: profile ? profile.status : undefined,
        vip_expire_time: profile ? profile.vip_expire_time : undefined,
        permissions: profile ? profile.permissions : undefined,
      });
    } catch (e) {
      return res.status(401).json({ detail: e.message || '刷新令牌无效或已过期' });
    }
  },
);

module.exports = router;
