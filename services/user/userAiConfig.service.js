/**
 * 用户侧 AI 任务模型 / 提示词配置（本人隔离；超管开关控制）
 */

const { dbAdmin } = require('../../dbClient')
const {
  AI_TASK_CATALOG,
  getPromptConfigurableTasks,
  isPromptConfigurableTask,
} = require('../ai/ai.model')
const {
  isUserModelCustomizationEnabled,
  isUserPromptCustomizationEnabled,
} = require('../ai/ai.featureFlags')
const {
  getCodeDefaultInstruction,
  resolveDisplayInstruction,
} = require('../ai/ai.promptResolve')
const { logAdminAction } = require('../admin/admin.common.service')

const MAX_INSTRUCTION_LEN = 8000

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 })
}

function assertTask(taskType) {
  const def = AI_TASK_CATALOG.find((item) => item.task_type === taskType)
  if (!def) throw badRequest('未知的 AI 任务类型')
  return def
}

/** 提示词配置仅允许白名单任务，防止对隐藏任务写入覆盖 */
function assertPromptConfigurableTask(taskType) {
  const def = assertTask(taskType)
  if (!isPromptConfigurableTask(taskType)) {
    throw badRequest('该任务不支持自定义提示词')
  }
  return def
}

async function listEnabledModels() {
  const { data, error } = await dbAdmin
    .from('ai_model')
    .select('id,name,model_key,provider,model_type,enabled')
    .eq('enabled', true)
    .order('create_time', { ascending: false })
  if (error) throw Object.assign(new Error(`查询模型失败：${error.message}`), { statusCode: 500 })
  return data || []
}

async function getGlobalTaskModelId(taskType) {
  const { data } = await dbAdmin
    .from('ai_task_model')
    .select('model_id')
    .eq('task_type', taskType)
    .maybeSingle()
  return data?.model_id || null
}

/**
 * 用户任务模型列表：含平台默认、个人覆盖与可选模型
 */
async function listUserTaskModels(userId) {
  const customizationEnabled = await isUserModelCustomizationEnabled()
  const models = await listEnabledModels()
  const modelMap = new Map(models.map((m) => [m.id, m]))

  const { data: overrides } = await dbAdmin
    .from('user_ai_task_model')
    .select('*')
    .eq('user_id', userId)
  const overrideMap = new Map((overrides || []).map((row) => [row.task_type, row]))

  const items = []
  for (const task of AI_TASK_CATALOG) {
    const globalModelId = await getGlobalTaskModelId(task.task_type)
    const override = overrideMap.get(task.task_type)
    const overrideModelId = override?.model_id || null
    const effectiveId = (customizationEnabled && overrideModelId) || globalModelId
    items.push({
      task_type: task.task_type,
      name: task.name,
      required_model_type: task.required_model_type,
      global_model_id: globalModelId,
      override_model_id: customizationEnabled ? overrideModelId : null,
      model_id: effectiveId,
      model: effectiveId ? modelMap.get(effectiveId) || null : null,
      has_override: Boolean(customizationEnabled && overrideModelId),
    })
  }

  return {
    customization_enabled: customizationEnabled,
    items,
    // 开关关闭时不暴露可选模型列表，避免前端误展示可写态
    models: customizationEnabled ? models : [],
  }
}

async function upsertUserTaskModel(userId, taskType, modelId) {
  if (!(await isUserModelCustomizationEnabled())) {
    throw forbidden('管理员尚未开放用户自定义模型')
  }
  const task = assertTask(taskType)
  const numericId = Number(modelId)
  if (!Number.isFinite(numericId)) throw badRequest('请选择有效模型')

  const { data: model } = await dbAdmin
    .from('ai_model')
    .select('*')
    .eq('id', numericId)
    .eq('enabled', true)
    .maybeSingle()
  if (!model) throw badRequest('模型不存在或未启用')
  if (model.model_type !== task.required_model_type) {
    throw badRequest(`该任务需要${task.required_model_type === 'vision' ? '视觉' : '文本'}模型`)
  }

  const now = new Date().toISOString()
  const { data: existing } = await dbAdmin
    .from('user_ai_task_model')
    .select('id')
    .eq('user_id', userId)
    .eq('task_type', taskType)
    .maybeSingle()

  if (existing) {
    const { data, error } = await dbAdmin
      .from('user_ai_task_model')
      .update({ model_id: numericId, update_time: now })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw Object.assign(new Error(`保存失败：${error.message}`), { statusCode: 500 })
    return data
  }

  const { data, error } = await dbAdmin
    .from('user_ai_task_model')
    .insert({
      user_id: userId,
      task_type: taskType,
      model_id: numericId,
      create_time: now,
      update_time: now,
    })
    .select()
    .single()
  if (error) throw Object.assign(new Error(`保存失败：${error.message}`), { statusCode: 500 })
  return data
}

async function deleteUserTaskModel(userId, taskType) {
  if (!(await isUserModelCustomizationEnabled())) {
    throw forbidden('管理员尚未开放用户自定义模型')
  }
  assertTask(taskType)
  const { error } = await dbAdmin
    .from('user_ai_task_model')
    .delete()
    .eq('user_id', userId)
    .eq('task_type', taskType)
  if (error) throw Object.assign(new Error(`清除失败：${error.message}`), { statusCode: 500 })
}

/**
 * 用户提示词列表：只返回 instruction，永不返回 Schema/输出格式
 */
async function listUserTaskPrompts(userId) {
  const customizationEnabled = await isUserPromptCustomizationEnabled()
  const items = []
  // 仅返回可配置提示词的任务，隐藏 PDF 等内部任务
  for (const task of getPromptConfigurableTasks()) {
    const display = await resolveDisplayInstruction(task.task_type, userId, {
      allowUser: customizationEnabled,
    })
    const { data: userRow } = customizationEnabled
      ? await dbAdmin
        .from('user_ai_task_prompt')
        .select('instruction')
        .eq('user_id', userId)
        .eq('task_type', task.task_type)
        .maybeSingle()
      : { data: null }

    items.push({
      task_type: task.task_type,
      name: task.name,
      // 展示用生效指令；来源 code/admin/user，不含锁定输出段
      instruction: display.instruction,
      source: display.source,
      has_override: Boolean(customizationEnabled && userRow?.instruction),
      // 编辑框默认值：仅个人覆盖；无覆盖时给代码/管理员默认便于参考
      editable_instruction: customizationEnabled
        ? String(userRow?.instruction || display.instruction || '')
        : '',
    })
  }
  return { customization_enabled: customizationEnabled, items }
}

async function upsertUserTaskPrompt(userId, taskType, instruction) {
  if (!(await isUserPromptCustomizationEnabled())) {
    throw forbidden('管理员尚未开放用户自定义提示词')
  }
  assertPromptConfigurableTask(taskType)
  const text = String(instruction || '').trim()
  if (!text) throw badRequest('提示词不能为空')
  if (text.length > MAX_INSTRUCTION_LEN) {
    throw badRequest(`提示词最长 ${MAX_INSTRUCTION_LEN} 字`)
  }

  const now = new Date().toISOString()
  const { data: existing } = await dbAdmin
    .from('user_ai_task_prompt')
    .select('id')
    .eq('user_id', userId)
    .eq('task_type', taskType)
    .maybeSingle()

  if (existing) {
    const { data, error } = await dbAdmin
      .from('user_ai_task_prompt')
      .update({ instruction: text, update_time: now })
      .eq('id', existing.id)
      .select('id,task_type,instruction,update_time')
      .single()
    if (error) throw Object.assign(new Error(`保存失败：${error.message}`), { statusCode: 500 })
    return data
  }

  const { data, error } = await dbAdmin
    .from('user_ai_task_prompt')
    .insert({
      user_id: userId,
      task_type: taskType,
      instruction: text,
      create_time: now,
      update_time: now,
    })
    .select('id,task_type,instruction,update_time')
    .single()
  if (error) throw Object.assign(new Error(`保存失败：${error.message}`), { statusCode: 500 })
  return data
}

async function deleteUserTaskPrompt(userId, taskType) {
  if (!(await isUserPromptCustomizationEnabled())) {
    throw forbidden('管理员尚未开放用户自定义提示词')
  }
  assertPromptConfigurableTask(taskType)
  const { error } = await dbAdmin
    .from('user_ai_task_prompt')
    .delete()
    .eq('user_id', userId)
    .eq('task_type', taskType)
  if (error) throw Object.assign(new Error(`恢复默认失败：${error.message}`), { statusCode: 500 })
}

/** 管理员：列出/保存全局默认业务指令 */
async function listAdminTaskPrompts() {
  const { data: rows } = await dbAdmin.from('ai_task_prompt').select('*')
  const map = new Map((rows || []).map((row) => [row.task_type, row]))
  // 管理端提示词页同样隐藏不可配置任务
  return getPromptConfigurableTasks().map((task) => {
    const row = map.get(task.task_type)
    return {
      task_type: task.task_type,
      name: task.name,
      instruction: row?.instruction || getCodeDefaultInstruction(task.task_type),
      source: row?.instruction ? 'admin' : 'code',
      updated: Boolean(row?.instruction),
    }
  })
}

async function upsertAdminTaskPrompt(req, taskType, instruction) {
  assertPromptConfigurableTask(taskType)
  const text = String(instruction || '').trim()
  if (!text) throw badRequest('提示词不能为空')
  if (text.length > MAX_INSTRUCTION_LEN) {
    throw badRequest(`提示词最长 ${MAX_INSTRUCTION_LEN} 字`)
  }
  const now = new Date().toISOString()
  const { data: existing } = await dbAdmin
    .from('ai_task_prompt')
    .select('id')
    .eq('task_type', taskType)
    .maybeSingle()

  let data
  if (existing) {
    const result = await dbAdmin
      .from('ai_task_prompt')
      .update({ instruction: text, update_time: now })
      .eq('id', existing.id)
      .select()
      .single()
    if (result.error) {
      throw Object.assign(new Error(`保存失败：${result.error.message}`), { statusCode: 500 })
    }
    data = result.data
  } else {
    const result = await dbAdmin
      .from('ai_task_prompt')
      .insert({
        task_type: taskType,
        instruction: text,
        create_time: now,
        update_time: now,
      })
      .select()
      .single()
    if (result.error) {
      throw Object.assign(new Error(`保存失败：${result.error.message}`), { statusCode: 500 })
    }
    data = result.data
  }
  await logAdminAction(req, 'upsert_ai_task_prompt', 'ai_task_prompt', taskType)
  return data
}

module.exports = {
  listUserTaskModels,
  upsertUserTaskModel,
  deleteUserTaskModel,
  listUserTaskPrompts,
  upsertUserTaskPrompt,
  deleteUserTaskPrompt,
  listAdminTaskPrompts,
  upsertAdminTaskPrompt,
}
