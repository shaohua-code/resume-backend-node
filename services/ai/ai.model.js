/**
 * AI 任务常量与模型选择
 * 统一维护任务类型和模型解析逻辑
 */

const { settings } = require('../../config');

const AI_TASK = {
  RESUME_GENERATE: 'resume_generate',
  PROJECT_OPTIMIZE: 'project_optimize',
  SUMMARY_OPTIMIZE: 'summary_optimize',
  SKILLS_OPTIMIZE: 'skills_optimize',
  INTERNSHIP_OPTIMIZE: 'internship_optimize',
  JD_MATCH: 'jd_match',
  SCORE: 'score',
  PDF_OPTIMIZE: 'pdf_optimize',
  // 基于岗位 JD 流式优化整份简历
  JD_RESUME_OPTIMIZE: 'jd_resume_optimize',
  // 从 JD 图片中提取岗位描述文本
  JD_IMAGE_EXTRACT: 'jd_image_extract',
  PDF_JD_OPTIMIZE: 'pdf_jd_optimize',
};

/**
 * 模型优先级：接口传入 > 业务专属环境变量 > 全局默认模型
 * @param {string} task 任务类型
 * @param {string} model 外部指定模型
 * @returns {string}
 */
function resolveModel(task, model) {
  if (model && String(model).trim()) {
    return String(model).trim();
  }
  const modelMap = {
    [AI_TASK.RESUME_GENERATE]: settings.DEEPSEEK_MODEL_RESUME_GENERATE,
    [AI_TASK.PROJECT_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.SUMMARY_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.SKILLS_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.INTERNSHIP_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.JD_MATCH]: settings.DEEPSEEK_MODEL_JD_MATCH,
    [AI_TASK.SCORE]: settings.DEEPSEEK_MODEL_SCORE,
    [AI_TASK.PDF_OPTIMIZE]: settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
    [AI_TASK.JD_RESUME_OPTIMIZE]: settings.DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE || settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
    [AI_TASK.JD_IMAGE_EXTRACT]: settings.DEEPSEEK_MODEL_VISION || settings.DEEPSEEK_MODEL,
    [AI_TASK.PDF_JD_OPTIMIZE]: settings.DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE || settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
  };
  return (modelMap[task] || settings.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
}

module.exports = {
  AI_TASK,
  resolveModel,
};
