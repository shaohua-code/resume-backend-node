/**
 * 用户级 AI 自定义能力开关（system_config，仅超级管理员可改）
 */

const { dbAdmin } = require('../../dbClient')

const CONFIG_KEYS = {
  MODEL: 'user_ai_model_customization',
  PROMPT: 'user_ai_prompt_customization',
}

async function readEnabledFlag(configKey) {
  const { data, error } = await dbAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', configKey)
    .maybeSingle()
  if (error || !data) return false
  const value = data.config_value || {}
  return value.enabled === true || value.enabled === 'true'
}

async function isUserModelCustomizationEnabled() {
  return readEnabledFlag(CONFIG_KEYS.MODEL)
}

async function isUserPromptCustomizationEnabled() {
  return readEnabledFlag(CONFIG_KEYS.PROMPT)
}

module.exports = {
  CONFIG_KEYS,
  isUserModelCustomizationEnabled,
  isUserPromptCustomizationEnabled,
}
