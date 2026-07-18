/**
 * AI 识别与优化任务的 DeepSeek 单次兜底策略。
 *
 * 这里不做递归重试：主调用失败后最多执行一次 fallback。若兜底也失败，
 * 重新抛出主调用的错误，保持控制器现有的状态码与错误文案语义。
 */

const DEEPSEEK_FALLBACK_TASKS = new Set([
  'resume_extract',
  'project_optimize',
  'summary_optimize',
  'skills_optimize',
  'internship_optimize',
  'work_experience_optimize',
  'pdf_optimize',
  'jd_resume_optimize',
  'pdf_jd_optimize',
]);

function shouldFallbackToDeepseek(task) {
  return DEEPSEEK_FALLBACK_TASKS.has(task);
}

async function withDeepseekFallback(task, primaryCall, fallbackCall, options = {}) {
  try {
    return await primaryCall();
  } catch (primaryError) {
    const canFallback = typeof options.canFallback !== 'function' || options.canFallback(primaryError);
    if (!shouldFallbackToDeepseek(task) || !canFallback) throw primaryError;

    try {
      return await fallbackCall();
    } catch (fallbackError) {
      // 保留首次错误供现有统一错误处理使用，同时给服务端诊断保留兜底错误。
      try {
        Object.defineProperty(primaryError, 'fallbackError', {
          value: fallbackError,
          configurable: true,
        });
      } catch (_) {
        // 极少数被冻结的 Error 对象不能扩展，不影响原错误继续上抛。
      }
      throw primaryError;
    }
  }
}

module.exports = {
  shouldFallbackToDeepseek,
  withDeepseekFallback,
};
