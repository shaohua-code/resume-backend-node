/**
 * 管理后台用户服务
 * 处理用户列表、详情、更新、密码重置、邮箱认领等业务逻辑
 */

const { canManageRole, ROLES } = require('../../utils/permissions');
const userRepo = require('../../repositories/user.repository');
const { sanitizeKeyword, logAdminAction, getOwnedUserIds, canAccessUser } = require('./admin.common.service');
const { supabaseAdmin } = require('../../supabaseClient');

/**
 * 分页查询用户列表
 * 普通管理员仅返回归属自己的用户；超级管理员返回所有用户
 * 当查询管理员账号时（mode=admins），会额外为每个管理员附加其管理的用户数量
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 用户列表结果 { total, items }
 */
async function listUsers(req, from, to) {
  const keyword = sanitizeKeyword(req.query.keyword);
  // 获取当前管理员的归属用户 ID 列表（超管返回 null）
  const ownedUserIds = await getOwnedUserIds(req.user);

  const { data, error, count } = await userRepo.listUsers({
    from,
    to,
    role: req.query.role,
    status: req.query.status,
    keyword,
    adminRole: req.user.role,
    ownedUserIds,
  });

  if (error) {
    throw Object.assign(new Error(`查询用户失败：${error.message}`), { statusCode: 500 });
  }

  let items = data || [];

  // 如果是管理员账号页面（查询 ADMIN/SUPER_ADMIN 角色），为每个管理员统计其管理的用户数量
  if (items.length > 0 && items[0].role && ['ADMIN', 'SUPER_ADMIN'].includes(items[0].role)) {
    // 批量获取所有管理员的管理用户数量
    const adminIds = items.map(item => item.user_id).filter(id => id);

    if (adminIds.length > 0) {
      // 查询每个管理员在 admin_user_relation 表中的关联用户数
      const { data: relationCounts, error: countError } = await supabaseAdmin
        .from('admin_user_relation')
        .select('admin_id')
        .in('admin_id', adminIds);

      if (!countError && relationCounts) {
        // 统计每个管理员的管理人数
        const countMap = {};
        relationCounts.forEach(relation => {
          countMap[relation.admin_id] = (countMap[relation.admin_id] || 0) + 1;
        });

        // 将管理人数附加到每个管理员数据上
        items = items.map(item => ({
          ...item,
          managed_count: countMap[item.user_id] || 0,
        }));
      }
    }
  }

  return { total: count || 0, items };
}

/**
 * 查询单个用户详情
 * 普通管理员仅可查询归属用户
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 用户详情
 */
async function getUser(req) {
  const { data, error } = await userRepo.findById(req.params.userId);

  if (error || !data) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  // 超级管理员可查看所有用户；普通管理员只能查看归属用户
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    const hasAccess = await canAccessUser(req.user, data.user_id);
    if (!hasAccess && req.user.id !== data.user_id) {
      throw Object.assign(new Error('无权查看该用户'), { statusCode: 403 });
    }
  }

  return data;
}

/**
 * 更新用户信息
 * 普通管理员仅可更新归属用户
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 更新后的用户数据
 */
async function updateUser(req) {
  const { data: target } = await userRepo.findById(req.params.userId);

  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  // 普通管理员只能操作归属用户
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    const hasAccess = await canAccessUser(req.user, target.user_id);
    if (!hasAccess) {
      throw Object.assign(new Error('无权修改该用户'), { statusCode: 403 });
    }
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
  const { data: target } = await userRepo.findById(req.params.userId);

  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  // 普通管理员只能重置归属用户密码
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    const hasAccess = await canAccessUser(req.user, target.user_id);
    if (!hasAccess) {
      throw Object.assign(new Error('无权重置该用户密码'), { statusCode: 403 });
    }
  }

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

/**
 * 通过邮箱认领用户（建立归属关系）
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 认领结果
 */
async function claimUser(req) {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) {
    throw Object.assign(new Error('请输入邮箱'), { statusCode: 400 });
  }

  // 查找目标用户
  const { data: target, error } = await userRepo.findByEmail(email);
  if (error || !target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 });
  }

  // 仅可认领 USER 角色用户
  if (target.role !== ROLES.USER) {
    throw Object.assign(new Error('仅可认领普通用户'), { statusCode: 400 });
  }

  // 校验该用户未被认领
  const { data: existing } = await supabaseAdmin
    .from('admin_user_relation')
    .select('id, admin_id')
    .eq('user_id', target.user_id)
    .maybeSingle();

  if (existing) {
    throw Object.assign(new Error('该用户已被其他管理员认领'), { statusCode: 409 });
  }

  // 写入归属关系
  const now = new Date().toISOString();
  const { error: insertError } = await supabaseAdmin.from('admin_user_relation').insert({
    admin_id: req.user.id,
    user_id: target.user_id,
    bind_type: 'EMAIL_CLAIM',
    create_time: now,
  });

  if (insertError) {
    throw Object.assign(new Error(`认领失败：${insertError.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'claim_user', 'user_profile', target.user_id);
  return { user_id: target.user_id, email: target.email, nickname: target.nickname };
}

module.exports = {
  listUsers,
  getUser,
  updateUser,
  resetPassword,
  claimUser,
};
