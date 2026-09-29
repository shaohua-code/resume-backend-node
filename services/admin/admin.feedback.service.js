/**
 * 管理后台用户反馈服务
 * 处理反馈列表、详情查询等业务逻辑，并按管理员归属隔离
 */

const feedbackRepo = require('../../repositories/feedback.repository');
const {
  attachUserProfiles,
  getOwnedUserIds,
  canAccessUser,
  findUserIdsByKeyword,
  parseAdminDateRange,
} = require('./admin.common.service');

/**
 * 分页查询用户反馈列表
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 反馈列表结果 { items, total, page, size }
 */
async function listFeedbacks(req, from, to) {
  const userIds = await getOwnedUserIds(req.user);
  // 用户与日期过滤在归属集合内执行，保持管理员与超管的既有数据边界。
  const { from: createdFrom, to: createdTo } = parseAdminDateRange(req.query);
  const matchingUserIds = await findUserIdsByKeyword(req.query.keyword, userIds);
  if (matchingUserIds && !matchingUserIds.length) {
    return {
      items: [],
      total: 0,
      page: Number(req.query.page || '1'),
      size: Number(req.query.size || '10'),
    };
  }
  const { data, error, count } = await feedbackRepo.listFeedbacks({
    from,
    to,
    userId: req.query.user_id,
    matchingUserIds,
    createdFrom,
    createdTo,
    userIds,
  });

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

  const hasAccess = await canAccessUser(req.user, data.user_id);
  if (!hasAccess) {
    throw Object.assign(new Error('无权查看该反馈'), { statusCode: 403 });
  }

  const [item] = await attachUserProfiles([data]);
  return item;
}

module.exports = {
  listFeedbacks,
  getFeedback,
};
