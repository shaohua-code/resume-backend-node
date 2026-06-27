/**
 * 认证路由模块
 * 基于 Supabase Auth 提供邮箱验证码登录：
 * 1. POST /api/auth/sendCode - 发送验证码到邮箱（Supabase 自动发送）
 * 2. POST /api/auth/login - 验证码登录（首次登录自动注册）
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { sendOtp, verifyOtp, refreshSession } = require('../services/auth_service');
const { ensureUserProfile } = require('../services/user_profile_service');

const router = express.Router();

/**
 * 发送验证码接口
 * 调用 Supabase Auth 的 signInWithOtp 接口
 * Supabase 会通过其内置邮件服务发送验证码
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
      // 转译 Supabase 常见错误，给前端更友好的中文提示
      const msg = e.message || '';
      if (/rate limit/i.test(msg)) {
        return res.status(429).json({
          detail: '邮件发送频率超限：Supabase 默认免费邮箱服务每小时最多 3 封，请稍后再试或在 Supabase 后台配置自定义 SMTP',
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
 * Supabase Auth 校验验证码成功后，自动签发 access_token 和 refresh_token
 * 用户不存在时由 Supabase 自动创建（auth.users 表）
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
 * 刷新 token 接口
 * 前端使用 refresh_token 换取新的 access_token
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
