/**
 * 管理后台简历服务
 * 处理简历列表、详情查询等业务逻辑
 */

const resumeRepo = require('../../repositories/resume.repository');
const { attachUserProfiles, getOwnedUserIds, canAccessUser } = require('./admin.common.service');

/**
 * 分页查询简历列表
 * 普通管理员仅返回归属用户的简历；超级管理员返回全部
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 简历列表结果 { total, items }
 */
async function listResumes(req, from, to) {
  const ownedUserIds = await getOwnedUserIds(req.user)
  const { data, error, count } = await resumeRepo.listAdmin({
    from,
    to,
    userId: req.query.user_id,
    userIds: ownedUserIds,
  })

  if (error) {
    throw Object.assign(new Error(`查询简历失败：${error.message}`), { statusCode: 500 });
  }

  const items = await attachUserProfiles(data || []);
  return { total: count || 0, items };
}

/**
 * 查询单份简历详情
 * 普通管理员仅能查看归属用户的简历
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 简历详情
 */
async function getResume(req) {
  const { data, error } = await resumeRepo.findByIdAdmin(req.params.id);

  if (error || !data) {
    throw Object.assign(new Error('简历不存在'), { statusCode: 404 });
  }

  const hasAccess = await canAccessUser(req.user, data.user_id)
  if (!hasAccess) {
    throw Object.assign(new Error('无权查看该简历'), { statusCode: 403 });
  }

  return data;
}

module.exports = {
  listResumes,
  getResume,
};
