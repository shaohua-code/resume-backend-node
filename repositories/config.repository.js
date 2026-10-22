/**
 * 系统配置数据仓库
 * 封装所有与 PostgreSQL system_config 表直接交互的操作
 */

const { dbAdmin } = require('../dbClient');

/**
 * 查询所有系统配置，按配置键排序
 * @returns {Promise<Object>} PostgreSQL 查询结果 { data, error }
 */
async function listConfigs() {
  return dbAdmin.from('system_config').select('*').order('config_key');
}

/**
 * 按配置键读取单条系统配置
 * @param {string} configKey
 */
async function getConfigByKey(configKey) {
  return dbAdmin.from('system_config').select('*').eq('config_key', configKey).maybeSingle();
}

/**
 * 新增或更新系统配置
 * @param {Object} payload - 配置数据
 * @returns {Promise<Object>} PostgreSQL 查询结果 { data, error }
 */
async function upsertConfig(payload) {
  return dbAdmin.from('system_config').upsert(payload).select().single();
}

module.exports = {
  listConfigs,
  getConfigByKey,
  upsertConfig,
};
