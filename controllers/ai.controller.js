/**
 * AI 控制器
 * 处理所有 AI 相关接口：简历生成、各类优化、JD 匹配、简历评分
 */

const aiService = require('../services/ai/ai.service');
const resumeRepo = require('../repositories/resume.repository');
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service');
const { success, error } = require('../utils/response');

function getRequestedModel(req) {
  return (req.body && req.body.model) || req.query.model || '';
}

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
    const aiOptions = { model, inputMode: isLazy ? 'lazy' : 'form' };
    const userInput = isLazy ? body : JSON.stringify(body);
    const { data, meta } = await aiService.generateResume(userInput, aiOptions);
    if (!data || Object.keys(data).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      return error(res, 500, 'AI生成简历失败，请重试');
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, data);
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return error(res, 403, e.message);
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      return error(res, 400, e.message);
    }
    return error(res, 500, `AI服务调用失败：${e.message}`);
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
    const aiOptions = { model, inputMode: isLazy ? 'lazy' : 'form' };
    const userInput = isLazy ? body : JSON.stringify(body);
    const { data, meta } = await aiService.generateResumeStream(userInput, aiOptions, (chunk) => {
      sendEvent({ chunk });
    });
    if (!data || Object.keys(data).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      sendEvent({ error: 'AI生成简历失败，请重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data });
    return res.end();
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
      return res.end();
    }
    sendEvent({ error: `AI服务调用失败：${e.message}` });
    return res.end();
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
    const { data, meta } = await aiService.optimizeProject(project_description, target_position || '', { model });
    if (!data || Object.keys(data).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return error(res, 500, 'AI优化失败，请重试');
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, data);
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return error(res, 403, e.message);
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      return error(res, 400, e.message);
    }
    return error(res, 500, `AI服务调用失败：${e.message}`);
  }
}

async function optimizeStream(req, res) {
  const type = req.params.type;
  const allowedTypes = ['summary', 'skills', 'project', 'internship'];
  if (!allowedTypes.includes(type)) {
    return error(res, 400, `不支持的优化类型：${type}`);
  }

  const taskType = type === 'internship' ? 'internship_optimize' : `${type}_optimize`;
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
      serviceResult = await aiService.optimizeSummaryStream(resume, targetPosition, { model }, (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'skills') {
      serviceResult = await aiService.optimizeSkillsStream(resume, targetPosition, { model }, (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'project') {
      const project = resume?.projects?.[index];
      if (!project) {
        sendEvent({ error: '项目不存在' });
        return res.end();
      }
      serviceResult = await aiService.optimizeProjectStream(project, resume, targetPosition, { model }, (chunk) => {
        sendEvent({ chunk });
      });
    } else if (type === 'internship') {
      const internship = resume?.internships?.[index];
      if (!internship) {
        sendEvent({ error: '实习经历不存在' });
        return res.end();
      }
      serviceResult = await aiService.optimizeInternshipStream(internship, resume, targetPosition, { model }, (chunk) => {
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
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
      return res.end();
    }
    sendEvent({ error: `AI服务调用失败：${e.message}` });
    return res.end();
  }
}

async function matchJd(req, res) {
  const taskType = 'jd_match';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const { resume_id, jd_text } = req.body || {};
    const resumeJson = await getResumeJson(req, resume_id);
    const { data: matchData, meta } = await aiService.matchJd(resumeJson, jd_text || '', { model });
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, matchData, '匹配分析完成');
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return error(res, 403, e.message);
    }
    await recordAiCall(req, taskType, model, false, e.message);
    return error(res, e.statusCode || 500, `AI服务调用失败：${e.message}`);
  }
}

async function score(req, res) {
  const taskType = 'score';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const resumeId = req.query.resume_id || req.body?.resume_id;
    const resumeJson = await getResumeJson(req, resumeId);
    const { data: scoreData, meta } = await aiService.scoreResume(resumeJson, { model });
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, scoreData, '评分完成');
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return error(res, 403, e.message);
    }
    await recordAiCall(req, taskType, model, false, e.message);
    return error(res, e.statusCode || 500, `AI服务调用失败：${e.message}`);
  }
}

module.exports = {
  generate,
  generateStream,
  optimize,
  optimizeStream,
  matchJd,
  score,
};
