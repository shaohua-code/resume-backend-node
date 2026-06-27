/**
 * 用户资料服务
 * Supabase Auth 只负责登录身份，这里维护业务角色、封禁状态和会员时间。
 */

const { supabaseAdmin } = require('../supabaseClient');
const { getEffectiveRole, getRolePermissions } = require('../utils/permissions');

function buildProfilePayload(user) {
  const metadata = user.user_metadata || {};
  return {
    user_id: user.id,
    email: user.email || '',
    nickname: metadata.nickname || (user.email ? user.email.split('@')[0] : '用户'),
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
  const { data, error } = await supabaseAdmin
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
  const { data: existing } = await supabaseAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (existing) {
    // 每次登录同步邮箱和昵称，角色与封禁状态由后台维护，不能被登录流程覆盖。
    const { data, error } = await supabaseAdmin
      .from('user_profile')
      .update({
        email: payload.email,
        nickname: payload.nickname,
        update_time: payload.update_time,
      })
      .eq('user_id', user.id)
      .select()
      .single();
    if (error) throw error;
    return attachPermissionInfo(data);
  }

  const { data, error } = await supabaseAdmin
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
  return attachPermissionInfo(data);
}

module.exports = {
  getUserProfile,
  ensureUserProfile,
};
