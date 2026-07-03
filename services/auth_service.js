/**
 * 认证服务模块
 * 基于 Supabase Auth 实现三种认证方式：
 * 1. 邮箱验证码（OTP）登录 - signInWithOtp + verifyOtp
 * 2. 邮箱验证码通过后设置密码注册 / 邮箱或用户名 + 密码登录
 * 3. 密码重置 - resetPasswordForEmail + updateUser
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

/**
 * 邮箱验证码通过后设置密码和用户名
 * 注册前已经通过 verifyOtp 证明邮箱归属，这里只负责补齐密码与用户元数据。
 */
async function setPasswordAfterEmailVerified(userId, password, username) {
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password,
    user_metadata: { username, nickname: username },
  });
  if (error) throw error;
  return data.user;
}

/**
 * 发送密码重置验证码（OTP）
 * 复用 Supabase Magic Link 的 OTP 能力，但邮件模板只显示 6 位数字验证码
 * 用户拿到验证码后在前端输入，完成身份校验再重置密码
 *
 * @param {string} email 用户邮箱
 */
async function sendPasswordResetCode(email) {
  const { data, error } = await supabaseAuth.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false, // 不自动注册，未注册邮箱不发送验证码
    },
  });
  if (error) throw error;
  return data;
}

/**
 * 校验重置验证码并更新密码
 * 使用 verifyOtp 验证邮箱归属后，再用 admin 权限更新该用户密码
 *
 * @param {string} email 用户邮箱
 * @param {string} code 6 位验证码
 * @param {string} newPassword 新密码
 */
async function verifyResetCodeAndUpdatePassword(email, code, newPassword) {
  // 先校验邮箱验证码，确认邮箱归属
  const { data, error } = await supabaseAuth.auth.verifyOtp({
    email,
    token: code,
    type: 'email',
  });
  if (error) {
    const err = new Error('验证码错误或已过期');
    err.statusCode = 400;
    throw err;
  }

  // 校验通过后，使用 admin 权限更新密码
  const { data: updateData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
    data.user.id,
    { password: newPassword }
  );
  if (updateError) throw updateError;
  return updateData.user;
}

/**
 * 邮箱 + 密码登录
 * @returns {Promise<{user, session}>}
 */
async function signInWithPassword(email, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

/**
 * 根据邮箱或用户名解析登录邮箱
 * 用户名保存在业务 profile 的 nickname 字段，最终仍使用 Supabase 邮箱密码登录。
 */
async function resolveLoginEmail(identifier) {
  const account = String(identifier || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) {
    return account;
  }
  const { data, error } = await supabaseAdmin
    .from('user_profile')
    .select('email')
    .eq('nickname', account)
    .single();
  if (error || !data || !data.email) {
    const err = new Error('账号不存在');
    err.statusCode = 404;
    throw err;
  }
  return data.email;
}

/**
 * 检查用户名是否已被业务资料占用
 * 用户名映射到 user_profile.nickname，用于用户名密码登录。
 */
async function isUsernameTaken(username) {
  const { count, error } = await supabaseAdmin
    .from('user_profile')
    .select('user_id', { count: 'exact', head: true })
    .eq('nickname', username);
  if (error) throw error;
  return (count || 0) > 0;
}

module.exports = {
  sendOtp,
  verifyOtp,
  getUserByToken,
  refreshSession,
  updateUserMetadata,
  setPasswordAfterEmailVerified,
  sendPasswordResetCode,
  verifyResetCodeAndUpdatePassword,
  signInWithPassword,
  resolveLoginEmail,
  isUsernameTaken,
};
