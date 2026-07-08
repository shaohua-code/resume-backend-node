/**
 * 管理后台公共服务
 * 提供日志记录、关键词清洗、用户画像附加等通用能力
 */

const { supabaseAdmin } = require('../../supabaseClient');

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

  const { data: profiles } = await supabaseAdmin
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
  await supabaseAdmin.from('admin_action_log').insert({
    admin_user_id: req.user.id,
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    create_time: new Date().toISOString(),
  });
}

module.exports = {
  sanitizeKeyword,
  attachUserProfiles,
  logAdminAction,
};
