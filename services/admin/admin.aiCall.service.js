/**
 * 管理后台 AI 调用记录服务
 * 处理 AI 调用记录列表查询，普通管理员仅返回归属用户的记录
 */

const aiCallRepo = require('../../repositories/aiCall.repository');
const { attachUserProfiles, getOwnedUserIds } = require('./admin.common.service');

/**
 * 分页查询 AI 调用记录
 * 普通管理员仅返回归属用户的记录；超级管理员返回所有
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} AI 调用列表结果 { total, items }
 */
async function listAiCalls(req, from, to) {
  // 获取归属用户 ID 列表（超管返回 null）
  const ownedUserIds = await getOwnedUserIds(req.user);

  const { data, error, count } = await aiCallRepo.listAiCalls({
    from,
    to,
    userId: req.query.user_id,
    taskType: req.query.task_type,
    userIds: ownedUserIds,
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
