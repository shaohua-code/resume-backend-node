/**
 * 超级管理员 AI 模型与任务路由配置。
 * API 密钥只保存环境变量名，不把密钥明文写入数据库。
 */

const { dbAdmin } = require('../../dbClient');
const { AI_TASK_CATALOG } = require('../ai/ai.model');
const { logAdminAction } = require('./admin.common.service');

const MODEL_FIELDS = [
  'name',
  'model_key',
  'provider',
  'model_type',
  'api_url',
  'api_key_env',
  'input_price_per_million',
  'cached_input_price_per_million',
  'output_price_per_million',
  'thinking_enabled',
  'enabled',
];

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeModelPayload(body = {}, partial = false) {
  const payload = {};
  for (const field of MODEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) payload[field] = body[field];
  }

  for (const field of ['name', 'model_key', 'provider', 'model_type', 'api_url', 'api_key_env']) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) payload[field] = String(payload[field] || '').trim();
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'name')) {
    if (!payload.name) throw badRequest('模型名称不能为空');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'model_key')) {
    if (!payload.model_key) throw badRequest('模型 Key 不能为空');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'provider')) {
    payload.provider = (payload.provider || 'deepseek').toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(payload.provider)) throw badRequest('供应商标识格式不正确');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'model_type')) {
    payload.model_type = (payload.model_type || 'text').toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(payload.model_type)) throw badRequest('模型类型格式不正确');
  }
  if (payload.api_url && !/^https:\/\//i.test(payload.api_url)) {
    throw badRequest('API 地址必须使用 HTTPS');
  }
  if (payload.api_key_env && !/^[A-Z_][A-Z0-9_]*$/.test(payload.api_key_env)) {
    throw badRequest('密钥环境变量名格式不正确');
  }

  for (const field of ['input_price_per_million', 'cached_input_price_per_million', 'output_price_per_million']) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const value = Number(payload[field]);
      if (!Number.isFinite(value) || value < 0) throw badRequest('模型单价必须是大于等于 0 的数字');
      payload[field] = value;
    }
  }
  // thinking_enabled is nullable: null = provider default, true/false = force request parameter.
  if (Object.prototype.hasOwnProperty.call(payload, 'thinking_enabled')) {
    payload.thinking_enabled = payload.thinking_enabled === null || payload.thinking_enabled === ''
      ? null
      : Boolean(payload.thinking_enabled);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) payload.enabled = Boolean(payload.enabled);
  return payload;
}

async function listModels() {
  const { data, error } = await dbAdmin.from('ai_model').select('*').order('create_time', { ascending: false });
  if (error) throw Object.assign(new Error(`查询模型失败：${error.message}`), { statusCode: 500 });
  return data || [];
}

async function createModel(req, body) {
  const now = new Date().toISOString();
  const payload = normalizeModelPayload(body);
  const { data, error } = await dbAdmin
    .from('ai_model')
    .insert({ ...payload, task_type: 'all', create_time: now, update_time: now })
    .select()
    .single();
  if (error) throw Object.assign(new Error(`创建模型失败：${error.message}`), { statusCode: 400 });
  await logAdminAction(req, 'create_ai_model', 'ai_model', data.id);
  return data;
}

async function updateModel(req, id, body) {
  const payload = normalizeModelPayload(body, true);
  if (!Object.keys(payload).length) throw badRequest('没有可更新的模型字段');

  // 已分配模型不能停用或改成不兼容类型，避免线上任务在保存后立即失效。
  if (payload.enabled === false || payload.model_type) {
    const { data: assignments, error: assignmentError } = await dbAdmin
      .from('ai_task_model')
      .select('*')
      .eq('model_id', id);
    if (assignmentError) throw Object.assign(new Error(`检查任务引用失败：${assignmentError.message}`), { statusCode: 500 });
    if (assignments?.length && payload.enabled === false) {
      throw badRequest('该模型仍被任务使用，请先切换任务模型后再停用');
    }
    const incompatible = (assignments || []).find((item) => item.required_model_type !== payload.model_type);
    if (incompatible) throw badRequest(`该模型仍被任务 ${incompatible.task_type} 使用，不能修改为不兼容类型`);
  }
  const { data, error } = await dbAdmin
    .from('ai_model')
    .update({ ...payload, update_time: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw Object.assign(new Error(`更新模型失败：${error.message}`), { statusCode: 400 });
  await logAdminAction(req, 'update_ai_model', 'ai_model', id);
  return data;
}

async function deleteModel(req, id) {
  const { data: assignment, error: assignmentError } = await dbAdmin
    .from('ai_task_model')
    .select('id')
    .eq('model_id', id)
    .limit(1);
  if (assignmentError) throw Object.assign(new Error(`检查任务引用失败：${assignmentError.message}`), { statusCode: 500 });
  if (assignment?.length) throw badRequest('该模型仍被任务使用，请先在任务模型配置页更换模型');
  const { error } = await dbAdmin.from('ai_model').delete().eq('id', id);
  if (error) throw Object.assign(new Error(`删除模型失败：${error.message}`), { statusCode: 400 });
  await logAdminAction(req, 'delete_ai_model', 'ai_model', id);
}

async function listTaskModels() {
  const [modelsResult, assignmentsResult] = await Promise.all([
    dbAdmin.from('ai_model').select('*').order('create_time', { ascending: false }),
    dbAdmin.from('ai_task_model').select('*'),
  ]);
  if (modelsResult.error) throw Object.assign(new Error(`查询模型失败：${modelsResult.error.message}`), { statusCode: 500 });
  if (assignmentsResult.error) throw Object.assign(new Error(`查询任务配置失败：${assignmentsResult.error.message}`), { statusCode: 500 });

  const models = modelsResult.data || [];
  const modelMap = Object.fromEntries(models.map((model) => [String(model.id), model]));
  const assignmentMap = Object.fromEntries((assignmentsResult.data || []).map((item) => [item.task_type, item]));
  const items = AI_TASK_CATALOG.map((task) => {
    const assignment = assignmentMap[task.task_type] || null;
    return {
      ...task,
      model_id: assignment?.model_id || null,
      model: assignment ? modelMap[String(assignment.model_id)] || null : null,
      update_time: assignment?.update_time || null,
    };
  });
  return { items, models };
}

async function updateTaskModel(req, taskType, modelId) {
  const task = AI_TASK_CATALOG.find((item) => item.task_type === taskType);
  if (!task) throw badRequest('不支持的 AI 任务类型');
  if (!Number.isInteger(Number(modelId)) || Number(modelId) <= 0) throw badRequest('请选择有效模型');
  const { data: model, error } = await dbAdmin
    .from('ai_model')
    .select('*')
    .eq('id', modelId)
    .maybeSingle();
  if (error || !model) throw badRequest('选择的模型不存在');
  if (!model.enabled) throw badRequest('不能为任务分配已停用模型');
  if (model.model_type !== task.required_model_type) {
    throw badRequest(`该任务需要${task.required_model_type === 'vision' ? '视觉' : '文本'}模型`);
  }

  const now = new Date().toISOString();
  const { data, error: saveError } = await dbAdmin
    .from('ai_task_model')
    .upsert({
      task_type: task.task_type,
      required_model_type: task.required_model_type,
      model_id: model.id,
      update_time: now,
    }, { onConflict: 'task_type' })
    .select()
    .single();
  if (saveError) throw Object.assign(new Error(`保存任务模型失败：${saveError.message}`), { statusCode: 500 });
  await logAdminAction(req, 'update_ai_task_model', 'ai_task_model', task.task_type);
  return { ...data, model };
}

module.exports = {
  listModels,
  createModel,
  updateModel,
  deleteModel,
  listTaskModels,
  updateTaskModel,
};
