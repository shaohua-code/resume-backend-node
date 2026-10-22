/**
 * 面向 C 端的公开应用配置（无需登录）
 */
const { getDefaultTemplateId } = require('../services/system/defaultTemplate.service');
const { success } = require('../utils/response');

async function getPublicSettings(req, res) {
  const default_template_id = await getDefaultTemplateId();
  return success(res, { default_template_id });
}

module.exports = {
  getPublicSettings,
};
