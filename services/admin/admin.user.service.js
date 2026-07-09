/**
 * 管理后台用户服务
 * 处理用户列表、详情、更新、密码重置等业务逻辑
 */

const { canManageRole } = require('../../utils/permissions');
const userRepo = require('../../repositories/user.repository');
const { sanitizeKeyword, logAdminAction } = require('./admin.common.service');

/**
 * 分页查询用户列表
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 用户列表结果 { total, items }
 */
async function listUsers(req, from, to) {
  const keyword = sanitizeKeyword(req.query.keyword);
  const { data, error, count } = await userRepo.listUsers({
    from,
    to,
    role: req.query.role,
    status: req.query.status,
    keyword,
    adminRole: req.user.role,
  });

  if (error) {
    throw Object.assign(new Error(`查询用户失败：${error.message}`), { statusCode: 500 });
  }

  return { total: count || 0, items: data || [] };
}

/**
 * 查询单个用户详情
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 用户详情
 */
async function getUser(req) {
  const { data, error } = await userRepo.findById(req.params.userId);

  if (error || !data) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  if (!canManageRole(req.user.role, data.role) && req.user.id !== data.user_id) {
    throw Object.assign(new Error('无权查看该用户'), { statusCode: 403 });
  }

  return data;
}

/**
 * 更新用户信息
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 更新后的用户数据
 */
async function updateUser(req) {
  const { data: target } = await userRepo.findById(req.params.userId);

  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  if (!canManageRole(req.user.role, target.role)) {
    throw Object.assign(new Error('无权修改该用户'), { statusCode: 403 });
  }

  const payload = {};
  if (req.body.role) {
    if (!canManageRole(req.user.role, req.body.role)) {
      throw Object.assign(new Error('无权设置该角色'), { statusCode: 403 });
    }
    payload.role = req.body.role;
  }
  if (req.body.status) payload.status = req.body.status;
  if (req.body.nickname) payload.nickname = req.body.nickname;
  payload.update_time = new Date().toISOString();

  const { data, error } = await userRepo.updateUser(req.params.userId, payload);

  if (error) {
    throw Object.assign(new Error(`更新用户失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'update_user', 'user_profile', req.params.userId);
  return data;
}

/**
 * 重置用户密码，生成 Supabase recovery 链接返回给管理员
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 重置链接信息
 */
async function resetPassword(req) {
  const { supabaseAdmin } = require('../../supabaseClient');
  const { data: target } = await userRepo.findById(req.params.userId);

  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  if (!canManageRole(req.user.role, target.role)) {
    throw Object.assign(new Error('无权重置该用户密码'), { statusCode: 403 });
  }

  // 当前项目使用邮箱验证码登录，重置密码以 Supabase recovery 链接形式返回给管理员。
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: target.email,
  });

  if (error) {
    throw Object.assign(new Error(`生成重置链接失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'reset_password', 'user_profile', req.params.userId);
  return { action_link: data.properties && data.properties.action_link };
}

module.exports = {
  listUsers,
  getUser,
  updateUser,
  resetPassword,
};
