/**
 * 管理后台通用 CRUD 服务
 * 为 plans/announcements/models 等简单表提供通用增删改查能力
 */

const { dbAdmin } = require('../../dbClient');
const { logAdminAction } = require('./admin.common.service');

/**
 * 查询指定表的所有记录
 * @param {string} table - 表名
 * @returns {Promise<Array<Object>>} 记录列表
 */
async function listItems(table) {
  const { data, error } = await dbAdmin
    .from(table)
    .select('*')
    .order('create_time', { ascending: false });

  if (error) {
    throw Object.assign(new Error(`查询失败：${error.message}`), { statusCode: 500 });
  }

  return data || [];
}

/**
 * 在指定表中创建新记录
 * @param {Object} req - Express 请求对象
 * @param {string} table - 表名
 * @param {Object} body - 请求体数据
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Promise<Object>} 创建后的记录
 */
async function createItem(req, table, body, idColumn = 'id') {
  const now = new Date().toISOString();
  const { data, error } = await dbAdmin
    .from(table)
    .insert({ ...body, create_time: now, update_time: now })
    .select()
    .single();

  if (error) {
    throw Object.assign(new Error(`创建失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, `create_${table}`, table, data[idColumn]);
  return data;
}

/**
 * 更新指定表中的记录
 * @param {Object} req - Express 请求对象
 * @param {string} table - 表名
 * @param {string} id - 记录 ID
 * @param {Object} body - 请求体数据
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Promise<Object>} 更新后的记录
 */
async function updateItem(req, table, id, body, idColumn = 'id') {
  const { data, error } = await dbAdmin
    .from(table)
    .update({ ...body, update_time: new Date().toISOString() })
    .eq(idColumn, id)
    .select()
    .single();

  if (error) {
    throw Object.assign(new Error(`更新失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, `update_${table}`, table, id);
  return data;
}

/**
 * 删除指定表中的记录
 * @param {Object} req - Express 请求对象
 * @param {string} table - 表名
 * @param {string} id - 记录 ID
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Promise<void>}
 */
async function deleteItem(req, table, id, idColumn = 'id') {
  const { error } = await dbAdmin.from(table).delete().eq(idColumn, id);

  if (error) {
    throw Object.assign(new Error(`删除失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, `delete_${table}`, table, id);
}

module.exports = {
  listItems,
  createItem,
  updateItem,
  deleteItem,
};
