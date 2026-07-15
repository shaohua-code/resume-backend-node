/**
 * AI 任务、模型类型与运行时路由
 * 优先读取后台任务映射；数据库尚未迁移或未配置时回退到环境变量。
 */

const { settings } = require('../../config');
const { dbAdmin } = require('../../dbClient');

const AI_MODEL_TYPE = {
  TEXT: 'text',
  VISION: 'vision',
};

const AI_TASK = {
  RESUME_GENERATE: 'resume_generate',
  PROJECT_OPTIMIZE: 'project_optimize',
  SUMMARY_OPTIMIZE: 'summary_optimize',
  SKILLS_OPTIMIZE: 'skills_optimize',
  INTERNSHIP_OPTIMIZE: 'internship_optimize',
  WORK_EXPERIENCE_OPTIMIZE: 'work_experience_optimize',
  JD_MATCH: 'jd_match',
  SCORE: 'score',
  PDF_OPTIMIZE: 'pdf_optimize',
  JD_RESUME_OPTIMIZE: 'jd_resume_optimize',
  JD_IMAGE_EXTRACT: 'jd_image_extract',
  PDF_JD_OPTIMIZE: 'pdf_jd_optimize',
};

const AI_TASK_CATALOG = [
  { task_type: AI_TASK.RESUME_GENERATE, name: '简历生成', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.PROJECT_OPTIMIZE, name: '项目经历优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.SUMMARY_OPTIMIZE, name: '个人评价优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.SKILLS_OPTIMIZE, name: '技能特长优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.INTERNSHIP_OPTIMIZE, name: '实习经历优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.WORK_EXPERIENCE_OPTIMIZE, name: '工作经历优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.JD_MATCH, name: '岗位匹配度分析', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.SCORE, name: '简历评分', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.PDF_OPTIMIZE, name: 'PDF 简历优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.JD_RESUME_OPTIMIZE, name: 'JD 简历优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.PDF_JD_OPTIMIZE, name: 'PDF + JD 优化', required_model_type: AI_MODEL_TYPE.TEXT },
  { task_type: AI_TASK.JD_IMAGE_EXTRACT, name: 'JD 图片识别', required_model_type: AI_MODEL_TYPE.VISION },
];

function getTaskDefinition(task) {
  return AI_TASK_CATALOG.find((item) => item.task_type === task) || null;
}

function getProviderDefaults(provider) {
  if (provider === 'dashscope') {
    return {
      apiKey: (settings.DASHSCOPE_API_KEY || '').trim(),
      apiUrl: settings.DASHSCOPE_API_URL,
      apiKeyEnv: 'DASHSCOPE_API_KEY',
    };
  }
  if (provider === 'deepseek') {
    return {
      apiKey: (settings.DEEPSEEK_API_KEY || '').trim(),
      apiUrl: settings.DEEPSEEK_API_URL,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    };
  }
  // 新供应商必须显式填写 API 地址与密钥环境变量，避免意外串用 DeepSeek 凭据。
  return { apiKey: '', apiUrl: '', apiKeyEnv: '' };
}

function toRuntime(model) {
  const provider = String(model.provider || 'deepseek').trim().toLowerCase();
  const defaults = getProviderDefaults(provider);
  const apiKeyEnv = String(model.api_key_env || defaults.apiKeyEnv).trim();
  return {
    id: model.id || null,
    name: model.name || model.model_key,
    modelKey: String(model.model_key || '').trim(),
    modelType: String(model.model_type || AI_MODEL_TYPE.TEXT).trim(),
    provider,
    apiUrl: String(model.api_url || defaults.apiUrl || '').trim(),
    apiKeyEnv,
    apiKey: String(process.env[apiKeyEnv] || defaults.apiKey || '').trim(),
    // null keeps the provider default; true/false explicitly toggles thinking-capable models.
    thinkingEnabled: typeof model.thinking_enabled === 'boolean' ? model.thinking_enabled : null,
  };
}

function getLegacyModelKey(task) {
  // 视觉任务仅在 DashScope 密钥存在时使用 Qwen；否则回退 DeepSeek 的视觉模型配置。
  if (task === AI_TASK.JD_IMAGE_EXTRACT) {
    if ((settings.DASHSCOPE_API_KEY || '').trim()) {
      return String(settings.DASHSCOPE_MODEL_VISION || 'qwen3.6-flash').trim();
    }
    return String(settings.DEEPSEEK_MODEL_VISION || settings.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
  }
  const modelMap = {
    [AI_TASK.RESUME_GENERATE]: settings.DEEPSEEK_MODEL_RESUME_GENERATE,
    [AI_TASK.PROJECT_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.SUMMARY_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.SKILLS_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.INTERNSHIP_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.WORK_EXPERIENCE_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.JD_MATCH]: settings.DEEPSEEK_MODEL_JD_MATCH,
    [AI_TASK.SCORE]: settings.DEEPSEEK_MODEL_SCORE,
    [AI_TASK.PDF_OPTIMIZE]: settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
    [AI_TASK.JD_RESUME_OPTIMIZE]: settings.DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE || settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
    [AI_TASK.PDF_JD_OPTIMIZE]: settings.DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE || settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
  };
  return String(modelMap[task] || settings.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
}

function buildLegacyRuntime(task, requestedModel = '') {
  const modelKey = String(requestedModel || getLegacyModelKey(task)).trim();
  const useDashscope = task === AI_TASK.JD_IMAGE_EXTRACT && Boolean((settings.DASHSCOPE_API_KEY || '').trim());
  const provider = useDashscope ? 'dashscope' : 'deepseek';
  return toRuntime({
    model_key: modelKey,
    name: modelKey,
    provider,
    model_type: getTaskDefinition(task)?.required_model_type || AI_MODEL_TYPE.TEXT,
  });
}

async function findEnabledModelByKey(modelKey) {
  const { data, error } = await dbAdmin
    .from('ai_model')
    .select('*')
    .eq('model_key', modelKey)
    .eq('enabled', true)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function findTaskModel(task) {
  const { data: assignment, error } = await dbAdmin
    .from('ai_task_model')
    .select('*')
    .eq('task_type', task)
    .maybeSingle();
  if (error || !assignment) return null;

  const { data: model, error: modelError } = await dbAdmin
    .from('ai_model')
    .select('*')
    .eq('id', assignment.model_id)
    .eq('enabled', true)
    .maybeSingle();
  if (modelError || !model) return null;
  return model;
}

/**
 * 解析任务实际使用的模型、供应商、地址与密钥。
 * 优先级：后台任务映射 > 接口显式模型（仅兼容未配置任务） > 环境变量回退。
 */
async function resolveModelConfig(task, requestedModel = '') {
  const taskDefinition = getTaskDefinition(task);
  let model = await findTaskModel(task);
  if (!model && requestedModel && String(requestedModel).trim()) {
    model = await findEnabledModelByKey(String(requestedModel).trim());
  }
  if (!model) {
    return buildLegacyRuntime(task, requestedModel);
  }

  const runtime = toRuntime(model);
  if (taskDefinition && runtime.modelType !== taskDefinition.required_model_type) {
    const err = new Error(`任务 ${taskDefinition.name} 需要${taskDefinition.required_model_type === AI_MODEL_TYPE.VISION ? '视觉' : '文本'}模型`);
    err.code = 'MODEL_TYPE_MISMATCH';
    err.statusCode = 400;
    throw err;
  }
  return runtime;
}

async function resolveModel(task, requestedModel = '') {
  const runtime = await resolveModelConfig(task, requestedModel);
  return runtime.modelKey;
}

module.exports = {
  AI_TASK,
  AI_TASK_CATALOG,
  AI_MODEL_TYPE,
  getTaskDefinition,
  resolveModel,
  resolveModelConfig,
};
