/**
 * AI 调用记录数据仓库
 * 封装所有与 Supabase ai_call_record 表直接交互的操作
 */

const { supabaseAdmin } = require('../supabaseClient');

/**
 * 按条件统计 AI 调用数量
 * @param {Function} builder - 用于附加过滤条件的查询构建函数
 * @returns {Promise<number>} AI 调用数量
 */
async function countAiCalls(builder) {
  let query = supabaseAdmin.from('ai_call_record').select('*', { count: 'exact', head: true });
  if (builder) {
    query = builder(query);
  }
  const { count } = await query;
  return count || 0;
}

/**
 * 分页查询 AI 调用记录
 * @param {Object} params - 查询参数
 * @param {number} params.from - 起始索引
 * @param {number} params.to - 结束索引
 * @param {string} [params.userId] - 按用户 ID 过滤
 * @param {string} [params.taskType] - 按任务类型过滤
 * @param {string[]|null} [params.userIds] - 按用户 ID 列表过滤（归属过滤）；null 表示不过滤
 * @returns {Promise<Object>} Supabase 查询结果 { data, error, count }
 */
async function listAiCalls({ from, to, userId, taskType, userIds }) {
  let query = supabaseAdmin
    .from('ai_call_record')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);

  // 归属用户过滤：userIds 为空数组时强制无结果；为 null 时不过滤
  if (userIds !== undefined && userIds !== null) {
    if (!userIds.length) {
      query = query.eq('user_id', '00000000-0000-0000-0000-000000000000');
    } else {
      query = query.in('user_id', userIds);
    }
  }

  if (userId) query = query.eq('user_id', userId);
  if (taskType) query = query.eq('task_type', taskType);

  return query;
}

/**
 * 查询指定时间之后的所有 AI 调用记录，用于趋势统计
 * @param {string} yearStart - 起始时间 ISO 字符串
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function findAllAiCalls(yearStart) {
  return supabaseAdmin
    .from('ai_call_record')
    .select('create_time')
    .gte('create_time', yearStart);
}

/**
 * 查询最近的 AI 调用任务类型分布
 * @param {number} limit - 查询条数
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function findRecentTaskTypes(limit = 500) {
  return supabaseAdmin
    .from('ai_call_record')
    .select('task_type')
    .order('create_time', { ascending: false })
    .limit(limit);
}

module.exports = {
  countAiCalls,
  listAiCalls,
  findAllAiCalls,
  findRecentTaskTypes,
};
