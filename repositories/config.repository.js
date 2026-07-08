/**
 * 系统配置数据仓库
 * 封装所有与 Supabase system_config 表直接交互的操作
 */

const { supabaseAdmin } = require('../supabaseClient');

/**
 * 查询所有系统配置，按配置键排序
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function listConfigs() {
  return supabaseAdmin.from('system_config').select('*').order('config_key');
}

/**
 * 新增或更新系统配置
 * @param {Object} payload - 配置数据
 * @returns {Promise<Object>} Supabase 查询结果 { data, error }
 */
async function upsertConfig(payload) {
  return supabaseAdmin.from('system_config').upsert(payload).select().single();
}

module.exports = {
  listConfigs,
  upsertConfig,
};
