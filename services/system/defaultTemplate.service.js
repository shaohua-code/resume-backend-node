/**
 * 新建简历默认模板（system_config.default_template_id）
 */
const configRepo = require('../../repositories/config.repository')

const CONFIG_KEY = 'default_template_id'
const FALLBACK_TEMPLATE_ID = 56
const MAX_TEMPLATE_ID = 60

let cachedId = null
let cachedAt = 0
const CACHE_TTL_MS = 5000

function sanitizeTemplateId(raw, fallback = FALLBACK_TEMPLATE_ID) {
  const id = Number(raw)
  if (Number.isInteger(id) && id >= 1 && id <= MAX_TEMPLATE_ID) return id
  return fallback
}

async function getDefaultTemplateId() {
  const now = Date.now()
  if (cachedId !== null && now - cachedAt < CACHE_TTL_MS) return cachedId
  const { data, error } = await configRepo.getConfigByKey(CONFIG_KEY)
  if (error || !data) {
    cachedId = FALLBACK_TEMPLATE_ID
    cachedAt = now
    return cachedId
  }
  cachedId = sanitizeTemplateId(data.config_value?.id)
  cachedAt = now
  return cachedId
}

function invalidateDefaultTemplateCache() {
  cachedId = null
  cachedAt = 0
}

function validateDefaultTemplateConfigValue(configValue) {
  const id = Number(configValue?.id)
  if (!Number.isInteger(id) || id < 1 || id > MAX_TEMPLATE_ID) {
    throw Object.assign(new Error('default_template_id.id 必须是 1–60 的整数'), { statusCode: 400 })
  }
  return { id }
}

module.exports = {
  CONFIG_KEY,
  FALLBACK_TEMPLATE_ID,
  MAX_TEMPLATE_ID,
  getDefaultTemplateId,
  invalidateDefaultTemplateCache,
  sanitizeTemplateId,
  validateDefaultTemplateConfigValue,
}
