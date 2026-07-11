/**
 * 管理后台公共服务
 * 提供日志记录、关键词清洗、用户画像附加、归属用户查询等通用能力
 */

const { dbAdmin } = require('../../dbClient');
const { ROLES } = require('../../utils/permissions');

/**
 * 清洗搜索关键词，移除首尾空格和特殊通配字符
 * @param {string} keyword - 原始关键词
 * @returns {string} 清洗后的关键词
 */
function sanitizeKeyword(keyword) {
  return String(keyword || '').trim().replace(/[,%]/g, '');
}

/**
 * 批量附加用户昵称与邮箱，供列表展示
 * @param {Array<Object>} items - 数据列表
 * @param {string} [userIdKey='user_id'] - 列表项中用户 ID 字段名
 * @returns {Promise<Array<Object>>} 附加 user 字段后的列表
 */
async function attachUserProfiles(items, userIdKey = 'user_id') {
  if (!items?.length) return items || [];

  const userIds = [...new Set(items.map((item) => item[userIdKey]).filter(Boolean))];
  if (!userIds.length) return items;

  const { data: profiles } = await dbAdmin
    .from('user_profile')
    .select('user_id, nickname, email')
    .in('user_id', userIds);

  const profileMap = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));

  return items.map((item) => ({
    ...item,
    user: profileMap[item[userIdKey]] || null,
  }));
}

/**
 * 记录管理员操作日志
 * @param {Object} req - Express 请求对象
 * @param {string} action - 操作类型
 * @param {string} [targetType=''] - 操作对象类型
 * @param {string} [targetId=''] - 操作对象 ID
 * @returns {Promise<void>}
 */
async function logAdminAction(req, action, targetType = '', targetId = '') {
  await dbAdmin.from('admin_action_log').insert({
    admin_user_id: req.user.id,
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    create_time: new Date().toISOString(),
  });
}

/**
 * 获取管理员归属的用户 ID 列表
 * 普通管理员只能看归属自己的用户；超级管理员返回 null 表示不做过滤
 * @param {Object} user - req.user 对象
 * @returns {Promise<string[]|null>} 用户 ID 数组；null 表示不过滤（超管）
 */
async function getOwnedUserIds(user) {
  // 超级管理员不做归属过滤
  if (user.role === ROLES.SUPER_ADMIN) {
    return null;
  }
  const { data, error } = await dbAdmin
    .from('admin_user_relation')
    .select('user_id')
    .eq('admin_id', user.id);

  if (error) {
    throw Object.assign(new Error(`查询归属用户失败：${error.message}`), { statusCode: 500 });
  }
  return (data || []).map((row) => row.user_id);
}

/**
 * 校验管理员是否有权访问目标用户
 * 超级管理员可访问所有用户；普通管理员只能访问归属用户
 * @param {Object} user - req.user 对象
 * @param {string} targetUserId - 目标用户 ID
 * @returns {Promise<boolean>}
 */
async function canAccessUser(user, targetUserId) {
  if (user.role === ROLES.SUPER_ADMIN) {
    return true;
  }
  const { data } = await dbAdmin
    .from('admin_user_relation')
    .select('id')
    .eq('admin_id', user.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  return !!data;
}

module.exports = {
  sanitizeKeyword,
  attachUserProfiles,
  logAdminAction,
  getOwnedUserIds,
  canAccessUser,
};
