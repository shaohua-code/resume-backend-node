/**
 * 用户数据仓库
 * 封装所有与 Supabase user_profile 表直接交互的操作
 */

const { supabaseAdmin } = require('../supabaseClient');
const { ROLES } = require('../utils/permissions');

/**
 * 按条件统计用户数量
 * @param {Function} builder - 用于附加过滤条件的查询构建函数
 * @returns {Promise<number>} 用户数量
 */
async function countUsers(builder) {
  let query = supabaseAdmin.from('user_profile').select('*', { count: 'exact', head: true });
  if (builder) {
    query = builder(query);
  }
  const { count } = await query;
  return count || 0;
}

/**
 * 分页查询用户列表
 * @param {Object} params - 查询参数
 * @param {number} params.from - 起始索引
 * @param {number} params.to - 结束索引
 * @param {string} [params.role] - 按角色过滤
 * @param {string} [params.status] - 按状态过滤
 * @param {string} [params.keyword] - 按邮箱或昵称模糊搜索
 * @param {string} params.adminRole - 当前管理员角色，用于数据范围控制
 * @returns {Promise<Object>} Supabase 查询结果 { data, error, count }
 */
async function listUsers({ from, to, role, status, keyword, adminRole }) {
  let query = supabaseAdmin
    .from('user_profile')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);

  // 普通管理员只能查看普通用户
  if (adminRole === ROLES.ADMIN) {
    query = query.eq('role', ROLES.USER);
  }

  if (role) query = query.eq('role', role);
  if (status) query = query.eq('status', status);
  if (keyword) query = query.or(`email.ilike.%${keyword}%,nickname.ilike.%${keyword}%`);

  return query;
}

/**
 * 根据用户 ID 查询用户信息
 * @param {string} userId - 用户 ID
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function findById(userId) {
  return supabaseAdmin.from('user_profile').select('*').eq('user_id', userId).single();
}

/**
 * 更新用户信息
 * @param {string} userId - 用户 ID
 * @param {Object} payload - 更新字段
 * @returns {Promise<Object>} Supabase 更新结果 { data, error }
 */
async function updateUser(userId, payload) {
  return supabaseAdmin
    .from('user_profile')
    .update(payload)
    .eq('user_id', userId)
    .select()
    .single();
}

module.exports = {
  countUsers,
  listUsers,
  findById,
  updateUser,
};
