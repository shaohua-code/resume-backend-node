/**
 * 管理后台数据大盘服务
 * 聚合统计指标、趋势图、订单概览、公告与系统状态
 */

const { supabaseAdmin } = require('../../supabaseClient');
const { ROLES } = require('../../utils/permissions');
const userRepo = require('../../repositories/user.repository');
const orderRepo = require('../../repositories/order.repository');
const aiCallRepo = require('../../repositories/aiCall.repository');

/**
 * 获取指定表的数量，支持自定义过滤条件
 * @param {string} table - 表名
 * @param {Function} [builder] - 查询构建函数
 * @returns {Promise<number>} 数量
 */
async function getTableCount(table, builder) {
  let query = supabaseAdmin.from(table).select('*', { count: 'exact', head: true });
  if (builder) {
    query = builder(query);
  }
  const { count } = await query;
  return count || 0;
}

/**
 * 计算某天的 0 点时间，用于今日/昨日等区间统计
 * @param {number} [offsetDay=0] - 相对今天的天数偏移
 * @returns {Date} 当天的开始时间
 */
function startOfDay(offsetDay = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDay);
  return date;
}

/**
 * 生成最近若干个月的月份键（YYYY-MM），用于趋势图分桶
 * @param {number} [count=12] - 月份数量
 * @returns {Array<string>} 月份键列表
 */
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

/**
 * 把一组记录按 create_time 的月份分桶累加，可选额外过滤条件
 * @param {Array<Object>} rows - 原始记录
 * @param {Array<string>} months - 月份键列表
 * @param {Function} [predicate] - 过滤函数
 * @returns {Array<number>} 每个月份的分桶计数
 */
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
 * 获取管理后台顶部统计卡片数据
 * @returns {Promise<Object>} 统计结果
 */
async function getStats() {
  const [userCount, vipCount, adminCount, resumeCount, orderCount, aiCallCount] = await Promise.all([
    getTableCount('user_profile'),
    userRepo.countUsers((query) => query.eq('role', ROLES.VIP)),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    orderRepo.countOrders(),
    aiCallRepo.countAiCalls(),
  ]);

  const { data: aiTasks } = await aiCallRepo.findRecentTaskTypes(500);
  const aiTaskMap = (aiTasks || []).reduce((acc, item) => {
    acc[item.task_type] = (acc[item.task_type] || 0) + 1;
    return acc;
  }, {});

  return {
    user_count: userCount,
    vip_count: vipCount,
    admin_count: adminCount,
    resume_count: resumeCount,
    order_count: orderCount,
    ai_call_count: aiCallCount,
    ai_task_stats: Object.entries(aiTaskMap).map(([task_type, count]) => ({ task_type, count })),
  };
}

/**
 * 获取管理后台数据中心大盘数据
 * @returns {Promise<Object>} 大盘聚合数据
 */
async function getDashboard() {
  const todayStart = startOfDay(0).toISOString();
  const yesterdayStart = startOfDay(-1).toISOString();
  const months = buildRecentMonths(12);
  const yearStart = new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1).toISOString();

  // 基础计数
  const [userCount, vipCount, adminCount, resumeCount, orderCount, todayNewUsers, yesterdayNewUsers] = await Promise.all([
    getTableCount('user_profile'),
    userRepo.countUsers((query) => query.eq('role', ROLES.VIP)),
    userRepo.countUsers((query) => query.in('role', [ROLES.ADMIN, ROLES.SUPER_ADMIN])),
    getTableCount('resume'),
    orderRepo.countOrders(),
    userRepo.countUsers((query) => query.gte('create_time', todayStart)),
    userRepo.countUsers((query) => query.gte('create_time', yesterdayStart).lt('create_time', todayStart)),
  ]);

  // 订单：营收与状态统计
  const { data: orders } = await orderRepo.findAllOrders('amount,status,create_time');
  const orderRows = orders || [];
  const paidOrders = orderRows.filter((item) => item.status === 'PAID');
  const totalAmount = orderRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidAmount = paidOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const pendingCount = orderRows.filter((item) => item.status === 'PENDING').length;

  // 趋势：近 12 个月的新增用户、付费用户、订单、AI 调用
  const [{ data: userRows }, { data: aiRows }] = await Promise.all([
    supabaseAdmin
      .from('user_profile')
      .select('create_time,role')
      .gte('create_time', yearStart),
    aiCallRepo.findAllAiCalls(yearStart),
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

  return {
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
  };
}

module.exports = {
  getStats,
  getDashboard,
};
