/**
 * 管理后台路由
 * 所有接口都先校验登录和管理员身份，再按模块权限做细粒度控制。
 */

const express = require('express');
const { supabaseAdmin } = require('../supabaseClient');
const { authRequired } = require('../middlewares/auth');
const { requireAdmin, requirePermission } = require('../middlewares/permission');
const { ROLES, PERMISSIONS, canManageRole } = require('../utils/permissions');

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

function parsePagination(req) {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const size = Math.min(Math.max(parseInt(req.query.size || '10', 10), 1), 100);
  return { page, size, from: (page - 1) * size, to: page * size - 1 };
}

function sanitizeKeyword(keyword) {
  return String(keyword || '').trim().replace(/[,%]/g, '');
}

// 批量附加用户昵称与邮箱，供列表展示
async function attachUserProfiles(items, userIdKey = 'user_id') {
  if (!items?.length) return items || []
  const userIds = [...new Set(items.map((item) => item[userIdKey]).filter(Boolean))]
  if (!userIds.length) return items
  const { data: profiles } = await supabaseAdmin
    .from('user_profile')
    .select('user_id, nickname, email')
    .in('user_id', userIds)
  const profileMap = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]))
  return items.map((item) => ({
    ...item,
    user: profileMap[item[userIdKey]] || null,
  }))
}

function applyAdminUserScope(query, req) {
  if (req.user.role === ROLES.ADMIN) {
    // 普通管理员只能管理普通用户和 VIP 用户，不能读取管理员列表。
    return query.in('role', [ROLES.USER, ROLES.VIP]);
  }
  return query;
}

async function logAdminAction(req, action, targetType = '', targetId = '') {
  await supabaseAdmin.from('admin_action_log').insert({
    admin_user_id: req.user.id,
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    create_time: new Date().toISOString(),
  });
}

async function getTableCount(table, builder) {
  let query = supabaseAdmin.from(table).select('*', { count: 'exact', head: true });
  if (builder) {
    query = builder(query);
  }
  const { count } = await query;
  return count || 0;
}

router.get('/stats', requirePermission(PERMISSIONS.ADMIN_STATS), async (req, res) => {
  const [userCount, vipCount, adminCount, resumeCount, orderCount, aiCallCount] = await Promise.all([
    getTableCount('user_profile'),
    getTableCount('user_profile', (query) => query.eq('role', ROLES.VIP)),
    getTableCount('user_profile', (query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    getTableCount('order_record'),
    getTableCount('ai_call_record'),
  ]);

  const { data: aiTasks } = await supabaseAdmin
    .from('ai_call_record')
    .select('task_type')
    .order('create_time', { ascending: false })
    .limit(500);
  const aiTaskMap = (aiTasks || []).reduce((acc, item) => {
    acc[item.task_type] = (acc[item.task_type] || 0) + 1;
    return acc;
  }, {});

  return res.json({
    success: true,
    data: {
      user_count: userCount,
      vip_count: vipCount,
      admin_count: adminCount,
      resume_count: resumeCount,
      order_count: orderCount,
      ai_call_count: aiCallCount,
      ai_task_stats: Object.entries(aiTaskMap).map(([task_type, count]) => ({ task_type, count })),
    },
  });
});

// 计算某天的 0 点时间，用于今日/昨日等区间统计
function startOfDay(offsetDay = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDay);
  return date;
}

// 生成最近 12 个月的月份键（YYYY-MM），用于趋势图分桶
function buildRecentMonths(count = 12) {
  const months = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    months.push(key);
  }
  return months;
}

// 把一组记录按 create_time 的月份分桶累加，可选额外过滤条件
function bucketByMonth(rows, months, predicate) {
  const counter = months.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
  (rows || []).forEach((row) => {
    if (predicate && !predicate(row)) return;
    const date = new Date(row.create_time);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (key in counter) {
      counter[key] += 1;
    }
  });
  return months.map((key) => counter[key]);
}

/**
 * 数据中心大盘聚合接口
 * 一次性返回统计卡、趋势图、订单概览、公告与系统状态所需数据。
 */
router.get('/dashboard', requirePermission(PERMISSIONS.ADMIN_STATS), async (req, res) => {
  const todayStart = startOfDay(0).toISOString();
  const yesterdayStart = startOfDay(-1).toISOString();
  const months = buildRecentMonths(12);
  const yearStart = new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1).toISOString();

  // 基础计数
  const [userCount, vipCount, adminCount, resumeCount, orderCount, todayNewUsers, yesterdayNewUsers] = await Promise.all([
    getTableCount('user_profile'),
    getTableCount('user_profile', (query) => query.eq('role', ROLES.VIP)),
    getTableCount('user_profile', (query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    getTableCount('order_record'),
    getTableCount('user_profile', (query) => query.gte('create_time', todayStart)),
    getTableCount('user_profile', (query) => query.gte('create_time', yesterdayStart).lt('create_time', todayStart)),
  ]);

  // 订单：营收与状态统计
  const { data: orders } = await supabaseAdmin
    .from('order_record')
    .select('amount,status,create_time');
  const orderRows = orders || [];
  const paidOrders = orderRows.filter((item) => item.status === 'PAID');
  const totalAmount = orderRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidAmount = paidOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const pendingCount = orderRows.filter((item) => item.status === 'PENDING').length;

  // 趋势：近 12 个月的新增用户、付费用户、订单、AI调用
  const [{ data: userRows }, { data: aiRows }] = await Promise.all([
    supabaseAdmin.from('user_profile').select('create_time,role').gte('create_time', yearStart),
    supabaseAdmin.from('ai_call_record').select('create_time').gte('create_time', yearStart),
  ]);

  const userTrend = bucketByMonth(userRows, months);
  const vipTrend = bucketByMonth(userRows, months, (row) => row.role === ROLES.VIP);
  const orderTrend = bucketByMonth(orderRows, months);
  const aiTrend = bucketByMonth(aiRows, months, () => true);

  // 最新公告
  const { data: announcements } = await supabaseAdmin
    .from('announcement')
    .select('id,title,enabled,create_time')
    .order('create_time', { ascending: false })
    .limit(5);

  // 系统状态：数据库以真实查询是否成功为准，其余服务默认正常
  const { error: dbError } = await supabaseAdmin.from('system_config').select('config_key').limit(1);
  const systemStatus = {
    api: 'ok',
    db: dbError ? 'error' : 'ok',
    ai: 'ok',
    storage: 'ok',
  };

  return res.json({
    success: true,
    data: {
      user_count: userCount,
      vip_count: vipCount,
      admin_count: adminCount,
      resume_count: resumeCount,
      order_count: orderCount,
      ai_call_count: aiTrend.reduce((sum, value) => sum + value, 0),
      today_new_users: todayNewUsers,
      user_growth: todayNewUsers - yesterdayNewUsers,
      total_amount: Number(totalAmount.toFixed(2)),
      paid_amount: Number(paidAmount.toFixed(2)),
      pending_count: pendingCount,
      months,
      user_trend: userTrend,
      vip_trend: vipTrend,
      order_trend: orderTrend,
      ai_trend: aiTrend,
      recent_announcements: announcements || [],
      system_status: systemStatus,
    },
  });
});

router.get('/users', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), async (req, res) => {
  const { from, to } = parsePagination(req);
  const keyword = sanitizeKeyword(req.query.keyword);
  let query = supabaseAdmin
    .from('user_profile')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);

  query = applyAdminUserScope(query, req);
  if (req.query.role) query = query.eq('role', req.query.role);
  if (req.query.status) query = query.eq('status', req.query.status);
  if (keyword) query = query.or(`email.ilike.%${keyword}%,nickname.ilike.%${keyword}%`);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ detail: `查询用户失败：${error.message}` });
  return res.json({ success: true, total: count || 0, items: data || [] });
});

router.get('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', req.params.userId)
    .single();
  if (error || !data) return res.status(404).json({ detail: '用户不存在' });
  if (!canManageRole(req.user.role, data.role) && req.user.id !== data.user_id) {
    return res.status(403).json({ detail: '无权查看该用户' });
  }
  return res.json({ success: true, data });
});

router.patch('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), async (req, res) => {
  const { data: target } = await supabaseAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', req.params.userId)
    .single();
  if (!target) return res.status(404).json({ detail: '用户不存在' });
  if (!canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ detail: '无权修改该用户' });
  }

  const payload = {};
  if (req.body.role) {
    if (!canManageRole(req.user.role, req.body.role)) {
      return res.status(403).json({ detail: '无权设置该角色' });
    }
    payload.role = req.body.role;
  }
  if (req.body.status) payload.status = req.body.status;
  if (Object.prototype.hasOwnProperty.call(req.body, 'vip_expire_time')) {
    payload.vip_expire_time = req.body.vip_expire_time || null;
  }
  if (req.body.nickname) payload.nickname = req.body.nickname;
  payload.update_time = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('user_profile')
    .update(payload)
    .eq('user_id', req.params.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ detail: `更新用户失败：${error.message}` });
  await logAdminAction(req, 'update_user', 'user_profile', req.params.userId);
  return res.json({ success: true, data, message: '用户已更新' });
});

router.post('/users/:userId/reset-password', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), async (req, res) => {
  const { data: target } = await supabaseAdmin
    .from('user_profile')
    .select('*')
    .eq('user_id', req.params.userId)
    .single();
  if (!target) return res.status(404).json({ detail: '用户不存在' });
  if (!canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ detail: '无权重置该用户密码' });
  }
  // 当前项目使用邮箱验证码登录，重置密码以 Supabase recovery 链接形式返回给管理员。
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: target.email,
  });
  if (error) return res.status(500).json({ detail: `生成重置链接失败：${error.message}` });
  await logAdminAction(req, 'reset_password', 'user_profile', req.params.userId);
  return res.json({ success: true, data: { action_link: data.properties && data.properties.action_link }, message: '重置链接已生成' });
});

router.get('/orders', requirePermission(PERMISSIONS.ADMIN_VIEW_ORDERS), async (req, res) => {
  const { from, to } = parsePagination(req);
  let query = supabaseAdmin
    .from('order_record')
    .select('*, membership_plan(name)', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ detail: `查询订单失败：${error.message}` });
  const items = await attachUserProfiles(data || []);
  return res.json({ success: true, total: count || 0, items });
});

router.post('/orders', requirePermission(PERMISSIONS.ADMIN_MANAGE_ORDERS), async (req, res) => {
  const now = new Date().toISOString();
  const payload = {
    user_id: req.body.user_id || null,
    plan_id: req.body.plan_id || null,
    order_no: req.body.order_no || `ADMIN${Date.now()}`,
    amount: Number(req.body.amount || 0),
    status: req.body.status || 'PENDING',
    pay_time: req.body.pay_time || null,
    create_time: now,
    update_time: now,
  };
  const { data, error } = await supabaseAdmin.from('order_record').insert(payload).select().single();
  if (error) return res.status(500).json({ detail: `创建订单失败：${error.message}` });
  await logAdminAction(req, 'create_order', 'order_record', data.id);
  return res.json({ success: true, data, message: '订单已创建' });
});

router.patch('/orders/:id', requirePermission(PERMISSIONS.ADMIN_MANAGE_ORDERS), async (req, res) => {
  const payload = {
    status: req.body.status,
    pay_time: req.body.pay_time || null,
    update_time: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from('order_record')
    .update(payload)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ detail: `更新订单失败：${error.message}` });
  await logAdminAction(req, 'update_order', 'order_record', req.params.id);
  return res.json({ success: true, data, message: '订单已更新' });
});

router.get('/ai-calls', requirePermission(PERMISSIONS.ADMIN_VIEW_AI_CALLS), async (req, res) => {
  const { from, to } = parsePagination(req);
  let query = supabaseAdmin
    .from('ai_call_record')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);
  if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
  if (req.query.task_type) query = query.eq('task_type', req.query.task_type);
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ detail: `查询AI调用失败：${error.message}` });
  const items = await attachUserProfiles(data || []);
  return res.json({ success: true, total: count || 0, items });
});

router.get('/resumes', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), async (req, res) => {
  const { from, to } = parsePagination(req);
  let query = supabaseAdmin
    .from('resume')
    .select('id,user_id,title,template_id,score,create_time,update_time', { count: 'exact' })
    .order('update_time', { ascending: false })
    .range(from, to);
  if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
  const { data, error, count } = await query;
  if (error) return res.status(500).json({ detail: `查询简历失败：${error.message}` });
  const items = await attachUserProfiles(data || []);
  return res.json({ success: true, total: count || 0, items });
});

router.get('/resumes/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('resume')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ detail: '简历不存在' });
  return res.json({ success: true, data });
});

router.get('/configs', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('system_config').select('*').order('config_key');
  if (error) return res.status(500).json({ detail: `查询配置失败：${error.message}` });
  return res.json({ success: true, items: data || [] });
});

router.put('/configs/:key', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), async (req, res) => {
  const payload = {
    config_key: req.params.key,
    config_value: req.body.config_value || {},
    description: req.body.description || '',
    update_time: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from('system_config')
    .upsert(payload)
    .select()
    .single();
  if (error) return res.status(500).json({ detail: `保存配置失败：${error.message}` });
  await logAdminAction(req, 'upsert_config', 'system_config', req.params.key);
  return res.json({ success: true, data, message: '配置已保存' });
});

function createCrudRoutes(path, table, permission, idColumn = 'id') {
  router.get(path, requirePermission(permission), async (req, res) => {
    const { data, error } = await supabaseAdmin.from(table).select('*').order('create_time', { ascending: false });
    if (error) return res.status(500).json({ detail: `查询失败：${error.message}` });
    return res.json({ success: true, items: data || [] });
  });

  router.post(path, requirePermission(permission), async (req, res) => {
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from(table)
      .insert({ ...req.body, create_time: now, update_time: now })
      .select()
      .single();
    if (error) return res.status(500).json({ detail: `创建失败：${error.message}` });
    await logAdminAction(req, `create_${table}`, table, data[idColumn]);
    return res.json({ success: true, data, message: '创建成功' });
  });

  router.patch(`${path}/:id`, requirePermission(permission), async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from(table)
      .update({ ...req.body, update_time: new Date().toISOString() })
      .eq(idColumn, req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ detail: `更新失败：${error.message}` });
    await logAdminAction(req, `update_${table}`, table, req.params.id);
    return res.json({ success: true, data, message: '更新成功' });
  });

  router.delete(`${path}/:id`, requirePermission(permission), async (req, res) => {
    const { error } = await supabaseAdmin.from(table).delete().eq(idColumn, req.params.id);
    if (error) return res.status(500).json({ detail: `删除失败：${error.message}` });
    await logAdminAction(req, `delete_${table}`, table, req.params.id);
    return res.json({ success: true, message: '删除成功' });
  });
}

createCrudRoutes('/plans', 'membership_plan', PERMISSIONS.ADMIN_MEMBERSHIP_PLAN);
createCrudRoutes('/announcements', 'announcement', PERMISSIONS.ADMIN_ANNOUNCEMENT);
createCrudRoutes('/models', 'ai_model', PERMISSIONS.ADMIN_AI_MODEL);

// 用户反馈（仅 SUPER_ADMIN）
router.get('/feedbacks', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), async (req, res) => {
  const { page, size, from, to } = parsePagination(req);
  const { data, error, count } = await supabaseAdmin
    .from('user_feedback')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(500).json({ detail: `查询失败：${error.message}` });
  }

  const items = await attachUserProfiles(data || []);
  return res.json({ success: true, items, total: count || 0, page, size });
});

router.get('/feedbacks/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_feedback')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ detail: '反馈不存在' });
  }

  const [item] = await attachUserProfiles([data]);
  return res.json({ success: true, data: item });
});

module.exports = router;
