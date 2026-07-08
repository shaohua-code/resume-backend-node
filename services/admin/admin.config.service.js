/**
 * 管理后台系统配置服务
 * 处理配置列表查询与新增/更新
 */

const configRepo = require('../../repositories/config.repository');
const { logAdminAction } = require('./admin.common.service');

/**
 * 查询所有系统配置
 * @returns {Promise<Array<Object>>} 配置列表
 */
async function listConfigs() {
  const { data, error } = await configRepo.listConfigs();

  if (error) {
    throw Object.assign(new Error(`查询配置失败：${error.message}`), { statusCode: 500 });
  }

  return data || [];
}

/**
 * 新增或更新系统配置
 * @param {Object} req - Express 请求对象
 * @returns {Promise<Object>} 保存后的配置数据
 */
async function upsertConfig(req) {
  const payload = {
    config_key: req.params.key,
    config_value: req.body.config_value || {},
    description: req.body.description || '',
    update_time: new Date().toISOString(),
  };

  const { data, error } = await configRepo.upsertConfig(payload);

  if (error) {
    throw Object.assign(new Error(`保存配置失败：${error.message}`), { statusCode: 500 });
  }

  await logAdminAction(req, 'upsert_config', 'system_config', req.params.key);
  return data;
}

module.exports = {
  listConfigs,
  upsertConfig,
};
