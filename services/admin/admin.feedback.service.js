/**
 * 管理后台用户反馈服务
 * 处理反馈列表、详情查询等业务逻辑
 */

const feedbackRepo = require('../../repositories/feedback.repository');
const { attachUserProfiles } = require('./admin.common.service');

/**
 * 分页查询用户反馈列表
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 反馈列表结果 { items, total, page, size }
 */
async function listFeedbacks(req, from, to) {
  const { data, error, count } = await feedbackRepo.listFeedbacks({ from, to });

  if (error) {
    throw Object.assign(new Error(`查询失败：${error.message}`), { statusCode: 500 });
  }

  const items = await attachUserProfiles(data || []);
  return {
    items,
    total: count || 0,
    page: Number(req.query.page || '1'),
    size: Number(req.query.size || '10'),
  };
}

/**
 * 查询单条用户反馈详情
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 反馈详情
 */
async function getFeedback(req) {
  const { data, error } = await feedbackRepo.findById(req.params.id);

  if (error || !data) {
    throw Object.assign(new Error('反馈不存在'), { statusCode: 404 });
  }

  const [item] = await attachUserProfiles([data]);
  return item;
}

module.exports = {
  listFeedbacks,
  getFeedback,
};
