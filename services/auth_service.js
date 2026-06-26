/**
 * 认证服务模块
 * 基于 Supabase Auth 实现邮箱验证码（OTP）登录
 *
 * Supabase Auth 流程：
 * 1. 调用 signInWithOtp({ email })，Supabase 自动发送验证码邮件给用户
 * 2. 调用 verifyOtp({ email, token, type: 'email' })，校验验证码并返回 access_token
 * 3. 后续请求携带 access_token，调用 getUser(token) 解析用户信息
 *
 * 用户表由 Supabase Auth 自动维护（auth.users 表），无需自己管理用户注册流程
 */

const { supabaseAuth, supabaseAdmin } = require('../supabaseClient');

/**
 * 发送邮箱验证码（OTP）
 * Supabase 会调用其内置的邮件服务发送 6 位数字验证码
 * 如果用户不存在，shouldCreateUser=true 会自动注册（首次登录）
 *
 * 重要：邮件内容是"验证码"还是"魔法链接"，由 Supabase 后台邮件模板决定！
 * - 模板包含 {{ .Token }}    → 邮件显示 6 位数字验证码
 * - 模板包含 {{ .ConfirmationURL }} → 邮件显示登录链接
 * 配置路径：Supabase Dashboard → Authentication → Email Templates → Magic Link
 */
async function sendOtp(email) {
  const { data, error } = await supabaseAuth.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true, // 用户不存在时自动注册（首次登录）
      // 不设置 emailRedirectTo，让 Supabase 优先发送验证码而非跳转链接
      // 如果项目站点 URL 在 Supabase 后台已配置，留空即可
      emailRedirectTo: undefined,
    },
  });
  if (error) throw error;
  return data;
}

/**
 * 校验邮箱验证码并完成登录
 * 成功后返回 Supabase 签发的 session（含 access_token、refresh_token、user）
 * @param {string} email 用户邮箱
 * @param {string} token 6位验证码
 */
async function verifyOtp(email, token) {
  const { data, error } = await supabaseAuth.auth.verifyOtp({
    email,
    token,
    type: 'email', // 邮箱 OTP 类型
  });
  if (error) throw error;
  return data; // { user, session }
}

/**
 * 通过 access_token 获取当前用户信息
 * 用于后续受保护接口的鉴权
 */
async function getUserByToken(accessToken) {
  const { data, error } = await supabaseAuth.auth.getUser(accessToken);
  if (error) return null;
  return data.user;
}

/**
 * 使用 refresh_token 换取新的 session
 * Supabase access_token 默认 1 小时过期，前端可调用此接口刷新
 */
async function refreshSession(refreshToken) {
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error) throw error;
  return data; // { session, user }
}

/**
 * 更新用户元数据（如昵称）
 * 使用 admin 客户端，可以更新任意用户
 */
async function updateUserMetadata(userId, metadata) {
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: metadata,
  });
  if (error) throw error;
  return data.user;
}

module.exports = {
  sendOtp,
  verifyOtp,
  getUserByToken,
  refreshSession,
  updateUserMetadata,
};
