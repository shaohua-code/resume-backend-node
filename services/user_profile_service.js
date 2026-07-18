/**
 * 用户资料服务
 * JWT 认证负责登录身份，这里维护业务角色、封禁状态。
 */

const { dbAdmin } = require('../dbClient');
const { getEffectiveRole, getRolePermissions } = require('../utils/permissions');
const { initWalletForNewUser } = require('./wallet/wallet.service');

function buildProfilePayload(user) {
  const metadata = user.user_metadata || {};
  const email = user.email || null;
  const account = user.account || metadata.username || '';
  return {
    user_id: user.id,
    // 随机账号注册时邮箱应保持 NULL，绑定成功后才同步真实邮箱。
    email,
    nickname: metadata.nickname || account || (email ? email.split('@')[0] : '用户'),
    update_time: new Date().toISOString(),
  };
}

function attachPermissionInfo(profile) {
  const role = getEffectiveRole(profile);
  return {
    ...profile,
    role,
    raw_role: profile.role,
    permissions: getRolePermissions(role),
  };
}

async function getUserProfile(userId) {
  const { data, error } = await dbAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    return null;
  }
  return attachPermissionInfo(data);
}

async function ensureUserProfile(user) {
  const payload = buildProfilePayload(user);
  const { data: existing } = await dbAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (existing) {
    // 每次登录同步邮箱；已有昵称由用户资料维护，不能被随机账号默认值覆盖。
    const { data, error } = await dbAdmin
      .from('user_profile')
      .update({
        email: payload.email,
        nickname: existing.nickname || payload.nickname,
        update_time: payload.update_time,
      })
      .eq('user_id', user.id)
      .select()
      .single();
    if (error) throw error;
    return attachPermissionInfo(data);
  }

  const { data, error } = await dbAdmin
    .from('user_profile')
    .insert({
      ...payload,
      role: 'USER',
      status: 'ACTIVE',
      create_time: payload.update_time,
    })
    .select()
    .single();
  if (error) throw error;
  // 资料兜底只创建零余额钱包；首次验证邮箱后才由认证事务发放一次赠金。
  await initWalletForNewUser(user.id);
  return attachPermissionInfo(data);
}

module.exports = {
  getUserProfile,
  ensureUserProfile,
};
