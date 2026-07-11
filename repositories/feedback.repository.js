/**
 * 用户反馈数据仓库
 * 封装所有与 PostgreSQL user_feedback 表直接交互的操作
 */

const { dbAdmin } = require('../dbClient');

/**
 * 统计用户反馈总数
 * @returns {Promise<number>} 反馈总数
 */
async function countFeedbacks() {
  const { count } = await dbAdmin
    .from('user_feedback')
    .select('*', { count: 'exact', head: true });
  return count || 0;
}

/**
 * 分页查询用户反馈列表
 * @param {Object} params - 查询参数
 * @param {number} params.from - 起始索引
 * @param {number} params.to - 结束索引
 * @returns {Promise<Object>} PostgreSQL 查询结果 { data, error, count }
 */
async function listFeedbacks({ from, to }) {
  return dbAdmin
    .from('user_feedback')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);
}

/**
 * 根据 ID 查询单条反馈
 * @param {string} id - 反馈 ID
 * @returns {Promise<Object>} PostgreSQL 查询结果 { data, error }
 */
async function findById(id) {
  return dbAdmin.from('user_feedback').select('*').eq('id', id).single();
}

module.exports = {
  countFeedbacks,
  listFeedbacks,
  findById,
};
