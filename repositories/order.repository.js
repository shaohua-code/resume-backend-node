/**
 * 订单数据仓库
 * 封装所有与 Supabase order_record 表直接交互的操作
 */

const { supabaseAdmin } = require('../supabaseClient');

/**
 * 按条件统计订单数量
 * @param {Function} builder - 用于附加过滤条件的查询构建函数
 * @returns {Promise<number>} 订单数量
 */
async function countOrders(builder) {
  let query = supabaseAdmin.from('order_record').select('*', { count: 'exact', head: true });
  if (builder) {
    query = builder(query);
  }
  const { count } = await query;
  return count || 0;
}

/**
 * 分页查询订单列表，并关联套餐名称
 * @param {Object} params - 查询参数
 * @param {number} params.from - 起始索引
 * @param {number} params.to - 结束索引
 * @param {string} [params.status] - 按状态过滤
 * @param {string} [params.userId] - 按用户 ID 过滤
 * @returns {Promise<Object>} Supabase 查询结果 { data, error, count }
 */
async function listOrders({ from, to, status, userId }) {
  let query = supabaseAdmin
    .from('order_record')
    .select('*, membership_plan(name)', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);
  if (userId) query = query.eq('user_id', userId);

  return query;
}

/**
 * 查询所有订单，用于大盘统计
 * @param {string} fields - 需要查询的字段列表
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function findAllOrders(fields = 'amount,status,create_time') {
  return supabaseAdmin.from('order_record').select(fields);
}

/**
 * 创建订单
 * @param {Object} payload - 订单数据
 * @returns {Promise<Object>} Supabase 插入结果 { data, error }
 */
async function createOrder(payload) {
  return supabaseAdmin.from('order_record').insert(payload).select().single();
}

/**
 * 更新订单
 * @param {string} id - 订单 ID
 * @param {Object} payload - 更新字段
 * @returns {Promise<Object>} Supabase 更新结果 { data, error }
 */
async function updateOrder(id, payload) {
  return supabaseAdmin
    .from('order_record')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
}

module.exports = {
  countOrders,
  listOrders,
  findAllOrders,
  createOrder,
  updateOrder,
};
