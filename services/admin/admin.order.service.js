/**
 * 管理后台订单服务
 * 处理订单列表、创建、更新等业务逻辑
 */

const orderRepo = require('../../repositories/order.repository');
const { attachUserProfiles, logAdminAction } = require('./admin.common.service');

/**
 * 分页查询订单列表
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 订单列表结果 { total, items }
 */
async function listOrders(req, from, to) {
  const { data, error, count } = await orderRepo.listOrders({
    from,
    to,
    status: req.query.status,
    userId: req.query.user_id,
  });

  if (error) {
    throw Object.assign(new Error(`查询订单失败：${error.message}`), { statusCode: 500 });
  }

  const items = await attachUserProfiles(data || []);
  return { total: count || 0, items };
}

/**
 * 创建新订单
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 创建后的订单数据
 */
async function createOrder(req) {
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

  const { data, error } = await orderRepo.createOrder(payload);

  if (error) {
    throw Object.assign(new Error(`创建订单失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'create_order', 'order_record', data.id);
  return data;
}

/**
 * 更新订单状态与时间
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 更新后的订单数据
 */
async function updateOrder(req) {
  const payload = {
    status: req.body.status,
    pay_time: req.body.pay_time || null,
    update_time: new Date().toISOString(),
  };

  const { data, error } = await orderRepo.updateOrder(req.params.id, payload);

  if (error) {
    throw Object.assign(new Error(`更新订单失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'update_order', 'order_record', req.params.id);
  return data;
}

module.exports = {
  listOrders,
  createOrder,
  updateOrder,
};
