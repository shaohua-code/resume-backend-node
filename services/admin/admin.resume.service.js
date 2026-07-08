/**
 * 管理后台简历服务
 * 处理简历列表、详情查询等业务逻辑
 */

const resumeRepo = require('../../repositories/resume.repository');
const { attachUserProfiles } = require('./admin.common.service');

/**
 * 分页查询简历列表
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 简历列表结果 { total, items }
 */
async function listResumes(req, from, to) {
  const { data, error, count } = await resumeRepo.listAdmin(from, to, req.query.user_id);

  if (error) {
    throw Object.assign(new Error(`查询简历失败：${error.message}`), { statusCode: 500 });
  }

  const items = await attachUserProfiles(data || []);
  return { total: count || 0, items };
}

/**
 * 查询单份简历详情
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 简历详情
 */
async function getResume(req) {
  const { data, error } = await resumeRepo.findByIdAdmin(req.params.id);

  if (error || !data) {
    throw Object.assign(new Error('简历不存在'), { statusCode: 404 });
  }

  return data;
}

module.exports = {
  listResumes,
  getResume,
};
