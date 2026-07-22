/**
 * AI 控制器
 * 处理所有 AI 相关接口：简历事实识别、简历生成、各类优化、岗位匹配分析、简历评分
 */

const aiService = require('../services/ai/ai.service');
const resumeRepo = require('../repositories/resume.repository');
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service');
const { success, error, sanitizePublicError } = require('../utils/response');
const multer = require('multer');

// JD 图片 OCR：内存存储，不落盘
const jdImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('仅支持图片文件（image/*）'));
    }
    cb(null, true);
  },
});

function getRequestedModel(req) {
  return (req.body && req.body.model) || req.query.model || '';
}

/** 透传调用用户，供模型/提示词用户级覆盖解析 */
function getAiOptions(req, extra = {}) {
  return { model: getRequestedModel(req), userId: req.user && req.user.id, ...extra };
}

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 统一处理 AI 接口错误，余额不足不重复加前缀 */
function respondAiError(res, e, { sendEvent, recordFn } = {}) {
  if (recordFn) recordFn(e.message);

  if (e.code === 'AI_LIMIT_EXCEEDED') {
    if (sendEvent) {
      sendEvent({ error: e.message, code: e.code });
      return res.end();
    }
    return error(res, 403, e.message);
  }
  if (e.code === 'INSUFFICIENT_BALANCE') {
    if (sendEvent) {
      sendEvent({ error: e.message, code: e.code });
      return res.end();
    }
    return error(res, 402, e.message, { code: e.code });
  }
  if (e.code === 'CONFIG_MISSING') {
    if (sendEvent) {
      sendEvent({ error: e.message, code: e.code });
      return res.end();
    }
    return error(res, 400, e.message);
  }
  // 识别链路业务错误：直接透传文案，避免包一层“AI服务调用失败”。
  if (['RESUME_TEXT_TOO_SHORT', 'RESUME_JSON_PARSE_FAILED', 'RESUME_JSON_TRUNCATED'].includes(e.code)) {
    if (sendEvent) {
      sendEvent({ error: e.message, code: e.code });
      return res.end();
    }
    return error(res, e.statusCode || 400, e.message, { code: e.code });
  }

  // 500 类错误统一脱敏，避免把模型/驱动原文推到 SSE 或 JSON
  const statusCode = e.statusCode || 500;
  const msg = sanitizePublicError(statusCode, e.message || 'AI 服务暂时不可用，请稍后重试');
  if (sendEvent) {
    sendEvent({ error: msg, code: e.code });
    return res.end();
  }
  return error(res, statusCode, msg, e.code ? { code: e.code } : {});
}

async function getResumeJson(req, resumeId) {
  const { data: resume, error: err } = await resumeRepo.findById(req.user.id, resumeId);
  if (err || !resume) {
    throw Object.assign(new Error('简历不存在'), { statusCode: 404 });
  }
  return resume.resume_json;
}

async function generate(req, res) {
  const taskType = 'resume_generate';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const body = req.body || {};
    const isLazy = body.input_mode === 'lazy';
    const aiOptions = getAiOptions(req, { inputMode: isLazy ? 'lazy' : 'form' });
    const userInput = isLazy ? body : JSON.stringify(body);
    const { data, meta } = await aiService.generateResume(userInput, aiOptions);
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      return error(res, 500, 'AI生成简历失败，请重试');
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, data);
  } catch (e) {
    return respondAiError(res, e, {
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function generateStream(req, res) {
  const taskType = 'resume_generate';
  const model = getRequestedModel(req);
  const sendEvent = setupSSE(res);
  try {
    await ensureAiQuota(req, taskType);
    const body = req.body || {};
    const isLazy = body.input_mode === 'lazy';
    const aiOptions = getAiOptions(req, { inputMode: isLazy ? 'lazy' : 'form' });
    const userInput = isLazy ? body : JSON.stringify(body);
    const { data, meta } = await aiService.generateResumeStream(userInput, aiOptions, (chunk) => {
      sendEvent({ chunk });
    });
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      sendEvent({ error: 'AI生成简历失败，请重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data });
    return res.end();
  } catch (e) {
    return respondAiError(res, e, {
      sendEvent,
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

/**
 * 从用户粘贴的简历文字中流式识别表单字段。
 * 该接口只提取原文事实，不进入简历生成或优化流程。
 */
async function extractResumeStream(req, res) {
  const taskType = 'resume_extract';
  const model = getRequestedModel(req);
  const rawText = String(req.body?.raw_text || '').trim();
  const sendEvent = setupSSE(res);

  try {
    await ensureAiQuota(req, taskType);
    sendEvent({ status: '正在识别文字中的简历字段...' });
    const { data, meta } = await aiService.extractResumeFromTextStream(
      rawText,
      getAiOptions(req),
      (chunk) => sendEvent({ chunk }),
    );
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, '未能识别出有效简历信息');
      sendEvent({ error: '未能识别出有效简历信息，请检查文字内容后重试' });
      return res.end();
    }

    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data: { resume: data.resume } });
    return res.end();
  } catch (e) {
    return respondAiError(res, e, {
      sendEvent,
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function optimize(req, res) {
  const taskType = 'project_optimize';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const { project_description, target_position } = req.body || {};
    if (!project_description) {
      return error(res, 400, 'project_description 不能为空');
    }
    const { data, meta } = await aiService.optimizeProject(project_description, target_position || '', getAiOptions(req));
    if (!data || Object.keys(data).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return error(res, 500, 'AI优化失败，请重试');
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, data);
  } catch (e) {
    return respondAiError(res, e, {
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function optimizeByJdStream(req, res) {
  const taskType = 'jd_resume_optimize';
  const model = getRequestedModel(req);
  const { resume, jd_text: jdText } = req.body || {};

  if (!resume || typeof resume !== 'object') {
    return error(res, 400, 'resume 必须是对象');
  }
  if (!jdText || !String(jdText).trim()) {
    return error(res, 400, 'jd_text 不能为空');
  }

  const sendEvent = setupSSE(res);
  try {
    await ensureAiQuota(req, taskType);
    const { data, meta } = await aiService.optimizeResumeByJdStream(
      resume,
      String(jdText).trim(),
      getAiOptions(req),
      (chunk) => {
        sendEvent({ chunk });
      },
    );
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      sendEvent({ error: 'AI优化失败，请重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data });
    return res.end();
  } catch (e) {
    return respondAiError(res, e, {
      sendEvent,
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

/**
 * 从 JD 图片中提取岗位描述文本（OCR / 视觉模型）
 * POST /api/ai/extract-jd-image
 */
async function extractJdImage(req, res) {
  const taskType = 'jd_image_extract';
  jdImageUpload.single('file')(req, res, async (uploadErr) => {
    const model = getRequestedModel(req);
    if (uploadErr) {
      return error(res, 400, uploadErr.message || '图片上传失败');
    }
    if (!req.file || !req.file.buffer) {
      return error(res, 400, '请上传 JD 图片（字段名：file）');
    }
    try {
      await ensureAiQuota(req, taskType);
      const { data, meta } = await aiService.extractJdFromImage(
        req.file.buffer,
        req.file.mimetype,
        getAiOptions(req),
      );
      if (!data?.jd_text) {
        await recordAiCall(req, taskType, model, false, '未能从图片中提取 JD 内容');
        return error(res, 500, '未能从图片中提取 JD 内容，请换一张更清晰的图片或改用文本粘贴');
      }
      await recordAiCall(req, taskType, model, true, '', meta);
      return success(res, data, 'JD 提取完成');
    } catch (e) {
      if (e.code === 'CONFIG_MISSING') return error(res, 400, e.message);
      if (e.code === 'AI_LIMIT_EXCEEDED') return error(res, 403, e.message);
      await recordAiCall(req, taskType, model, false, e.message);
      console.error('[extractJdImage] error:', e);
      return error(res, e.statusCode || 500, `提取失败：${e.message}`);
    }
  });
}

/**
 * 从 JD 图片中流式提取岗位描述文本（OCR / 视觉模型）
 * POST /api/ai/extract-jd-image/stream
 */
async function extractJdImageStream(req, res) {
  const taskType = 'jd_image_extract';
  jdImageUpload.single('file')(req, res, async (uploadErr) => {
    const model = getRequestedModel(req);
    if (uploadErr) {
      return error(res, 400, uploadErr.message || '图片上传失败');
    }
    if (!req.file || !req.file.buffer) {
      return error(res, 400, '请上传 JD 图片（字段名：file）');
    }

    const sendEvent = setupSSE(res);
    try {
      await ensureAiQuota(req, taskType);
      const { data, meta } = await aiService.extractJdFromImageStream(
        req.file.buffer,
        req.file.mimetype,
        getAiOptions(req),
        (chunk) => {
          sendEvent({ chunk });
        },
      );
      if (!data?.jd_text) {
        await recordAiCall(req, taskType, model, false, '未能从图片中提取 JD 内容');
        sendEvent({ error: '未能从图片中提取 JD 内容，请换一张更清晰的图片或改用文本粘贴' });
        return res.end();
      }
      await recordAiCall(req, taskType, model, true, '', meta);
      sendEvent({ done: true, data });
      return res.end();
    } catch (e) {
      console.error('[extractJdImageStream] error:', e);
      return respondAiError(res, e, {
        sendEvent,
        recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
      });
    }
  });
}

async function optimizeStream(req, res) {
  const type = req.params.type;
  // 支持的优化类型（含工作经历）
  const allowedTypes = ['summary', 'skills', 'project', 'internship', 'work_experience'];
  if (!allowedTypes.includes(type)) {
    return error(res, 400, `不支持的优化类型：${type}`);
  }

  // 任务类型映射（work_experience 使用独立标识）
  const taskTypeMap = {
    internship: 'internship_optimize',
    work_experience: 'work_experience_optimize',
  };
  const taskType = taskTypeMap[type] || `${type}_optimize`;
  const model = getRequestedModel(req);
  const { resume, index } = req.body || {};
  const targetPosition = resume?.target_position || '';

  if (!targetPosition) {
    return error(res, 400, '请先填写意向岗位');
  }

  const sendEvent = setupSSE(res);
  try {
    await ensureAiQuota(req, taskType);

    let serviceResult;
    if (type === 'summary') {
      serviceResult = await aiService.optimizeSummaryStream(resume, targetPosition, getAiOptions(req), (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'skills') {
      serviceResult = await aiService.optimizeSkillsStream(resume, targetPosition, getAiOptions(req), (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'project') {
      const project = resume?.projects?.[index];
      if (!project) {
        sendEvent({ error: '项目不存在' });
        return res.end();
      }
      serviceResult = await aiService.optimizeProjectStream(project, resume, targetPosition, getAiOptions(req), (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'internship') {
      const internship = resume?.internships?.[index];
      if (!internship) {
        sendEvent({ error: '实习经历不存在' });
        return res.end();
      }
      serviceResult = await aiService.optimizeInternshipStream(internship, resume, targetPosition, getAiOptions(req), (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'work_experience') {
      // 工作经历（正式全职）优化
      const workExp = resume?.work_experiences?.[index];
      if (!workExp) {
        sendEvent({ error: '工作经历不存在' });
        return res.end();
      }
      serviceResult = await aiService.optimizeWorkExperienceStream(workExp, resume, targetPosition, getAiOptions(req), (chunk) => {
        sendEvent({ chunk });
      });
    }

    if (!serviceResult?.data || Object.keys(serviceResult.data).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      sendEvent({ error: 'AI优化失败，请重试' });
      return res.end();
    }

    await recordAiCall(req, taskType, model, true, '', serviceResult.meta);
    sendEvent({ done: true, data: serviceResult.data });
    return res.end();
  } catch (e) {
    return respondAiError(res, e, {
      sendEvent,
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function matchJd(req, res) {
  const taskType = 'jd_match';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const { resume_id, jd_text } = req.body || {};
    const resumeJson = await getResumeJson(req, resume_id);
    const { data: matchData, meta } = await aiService.matchJd(resumeJson, jd_text || '', getAiOptions(req));
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, matchData, '匹配分析完成');
  } catch (e) {
    return respondAiError(res, e, {
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function score(req, res) {
  const taskType = 'score';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const resumeId = req.query.resume_id || req.body?.resume_id;
    const resumeJson = await getResumeJson(req, resumeId);
    const { data: scoreData, meta } = await aiService.scoreResume(resumeJson, getAiOptions(req));
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, scoreData, '评分完成');
  } catch (e) {
    return respondAiError(res, e, {
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

async function scoreStream(req, res) {
  const taskType = 'score';
  const model = getRequestedModel(req);
  const sendEvent = setupSSE(res);
  try {
    await ensureAiQuota(req, taskType);
    const resumeId = req.query.resume_id || req.body?.resume_id;
    const resumeJson = await getResumeJson(req, resumeId);
    const { data: scoreData, meta } = await aiService.scoreResumeStream(resumeJson, getAiOptions(req), (chunk) => {
      sendEvent({ chunk });
    });
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data: scoreData });
    return res.end();
  } catch (e) {
    return respondAiError(res, e, {
      sendEvent,
      recordFn: (msg) => recordAiCall(req, taskType, model, false, msg),
    });
  }
}

module.exports = {
  generate,
  generateStream,
  extractResumeStream,
  optimize,
  optimizeByJdStream,
  extractJdImage,
  extractJdImageStream,
  optimizeStream,
  matchJd,
  score,
  scoreStream,
};
