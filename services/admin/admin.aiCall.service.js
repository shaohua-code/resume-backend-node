/**
 * 管理后台 AI 调用记录服务
 * 处理 AI 调用记录列表查询
 */

const aiCallRepo = require('../../repositories/aiCall.repository');
const { attachUserProfiles } = require('./admin.common.service');

/**
 * 分页查询 AI 调用记录
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} AI 调用列表结果 { total, items }
 */
async function listAiCalls(req, from, to) {
  const { data, error, count } = await aiCallRepo.listAiCalls({
    from,
    to,
    userId: req.query.user_id,
    taskType: req.query.task_type,
  });

  if (error) {
    throw Object.assign(new Error(`查询AI调用失败：${error.message}`), { statusCode: 500 });
  }

  const items = await attachUserProfiles(data || []);
  return { total: count || 0, items };
}

module.exports = {
  listAiCalls,
};
