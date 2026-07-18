/**
 * PDF 控制器
 * 处理 PDF 上传、事实识别、AI 优化（同步/流式）以及文件管理
 */

const aiService = require('../services/ai/ai.service');
const pdfService = require('../services/pdf/pdf.service');
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service');
const { success, error } = require('../utils/response');

const upload = pdfService.buildMulterConfig();

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

async function parseAndOptimize(filePath, targetPosition, model, onChunk = null) {
  const pdfText = await pdfService.parsePdfFile(filePath);
  if (onChunk) {
    return aiService.optimizeFromPdfTextStream(pdfText, targetPosition, { model }, onChunk);
  }
  return aiService.optimizeFromPdfText(pdfText, targetPosition, { model });
}

/** PDF 原文 + JD 联合流式优化 */
async function parseAndOptimizeByJd(filePath, jdText, model, onChunk) {
  const pdfText = await pdfService.parsePdfFile(filePath);
  return aiService.optimizePdfByJdStream(pdfText, jdText, { model }, onChunk);
}

async function uploadOptimize(req, res) {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return error(res, 400, uploadErr.message || '文件上传失败');
    }
    if (!req.file) {
      return error(res, 400, '请上传 PDF 文件（字段名：file）');
    }
    const filePath = req.file.path;
    const targetPosition = req.body?.target_position || '';
    try {
      await ensureAiQuota(req, taskType);
      const { data, meta } = await parseAndOptimize(filePath, targetPosition, model);
      if (!data || !data.resume || Object.keys(data.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
        return error(res, 500, 'AI优化失败，请重试');
      }
      await recordAiCall(req, taskType, model, true, '', meta);
      return success(res, {
        resume: data.resume,
        optimization_notes: data.optimization_notes || [],
        file_name: req.file.originalname,
        file_size: req.file.size,
      }, '简历优化完成');
    } catch (e) {
      if (e.code === 'CONFIG_MISSING') return error(res, 400, e.message);
      if (e.code === 'AI_LIMIT_EXCEEDED') return error(res, 403, e.message);
      await recordAiCall(req, taskType, model, false, e.message);
      console.error('[uploadOptimize] error:', e);
      return error(res, e.statusCode || 500, `处理失败：${e.message}`);
    }
  });
}

async function uploadOptimizeStream(req, res) {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  upload.single('file')(req, res, async (uploadErr) => {
    const sendEvent = setupSSE(res);
    if (uploadErr) {
      sendEvent({ error: uploadErr.message || '文件上传失败' });
      return res.end();
    }
    if (!req.file) {
      sendEvent({ error: '请上传 PDF 文件（字段名：file）' });
      return res.end();
    }
    const filePath = req.file.path;
    const targetPosition = req.body?.target_position || '';
    try {
      await ensureAiQuota(req, taskType);
      const pdfText = await pdfService.parsePdfFile(filePath);
      sendEvent({ status: 'PDF 解析完成，AI 正在优化...' });
      const { data, meta } = await aiService.optimizeFromPdfTextStream(pdfText, targetPosition, { model }, (chunk) => {
        sendEvent({ chunk });
      });
      if (!data || !data.resume || Object.keys(data.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
        sendEvent({ error: 'AI优化失败，请重试' });
        return res.end();
      }
      await recordAiCall(req, taskType, model, true, '', meta);
      sendEvent({
        done: true,
        data: {
          resume: data.resume,
          optimization_notes: data.optimization_notes || [],
          file_name: req.file.originalname,
          file_size: req.file.size,
        },
      });
      return res.end();
    } catch (e) {
      if (e.code === 'CONFIG_MISSING') {
        sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
        return res.end();
      }
      if (e.code === 'AI_LIMIT_EXCEEDED') {
        sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
        return res.end();
      }
      await recordAiCall(req, taskType, model, false, e.message);
      sendEvent({ error: `处理失败：${e.message}` });
      return res.end();
    }
  });
}

/**
 * 上传 PDF 并流式识别结构化表单字段。
 * 与历史 uploadOptimize 接口分离，识别阶段不做润色、补写或岗位优化。
 */
async function uploadRecognizeStream(req, res) {
  const taskType = 'resume_extract';
  upload.single('file')(req, res, async (uploadErr) => {
    const sendEvent = setupSSE(res);
    if (uploadErr) {
      sendEvent({ error: uploadErr.message || '文件上传失败' });
      return res.end();
    }
    if (!req.file) {
      sendEvent({ error: '请上传 PDF 文件（字段名：file）' });
      return res.end();
    }

    // multipart 字段只有在 multer 完成后才可读取，避免忽略前端传入的模型。
    const model = getRequestedModel(req);
    try {
      await ensureAiQuota(req, taskType);
      sendEvent({ status: '正在解析 PDF 文本...' });
      const pdfText = await pdfService.parsePdfFile(req.file.path);
      sendEvent({ status: 'PDF 解析完成，正在识别简历字段...' });
      const { data, meta } = await aiService.extractResumeFromTextStream(
        pdfText,
        { model },
        (chunk) => sendEvent({ chunk }),
      );
      if (!data?.resume || Object.keys(data.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, '未能识别出有效简历信息');
        sendEvent({ error: '未能识别出有效简历信息，请检查 PDF 内容后重试' });
        return res.end();
      }

      await recordAiCall(req, taskType, model, true, '', meta);
      sendEvent({ done: true, data: { resume: data.resume } });
      return res.end();
    } catch (e) {
      if (['CONFIG_MISSING', 'AI_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESUME_TEXT_TOO_SHORT', 'RESUME_JSON_PARSE_FAILED'].includes(e.code)) {
        sendEvent({ error: e.message, code: e.code });
        return res.end();
      }
      await recordAiCall(req, taskType, model, false, e.message);
      sendEvent({ error: `识别失败：${e.message}` });
      return res.end();
    }
  });
}

/**
 * 使用已上传 PDF 流式纯识别（SSE），无需重新上传。
 * 与 uploadRecognizeStream 共用 resume_extract，不做润色或优化。
 */
async function existingRecognizeStream(req, res) {
  const taskType = 'resume_extract';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const sendEvent = setupSSE(res);
  const filePath = pdfService.getUserPdfPath(userId);
  if (!pdfService.getFileMeta(userId)) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF' });
    return res.end();
  }
  try {
    await ensureAiQuota(req, taskType);
    sendEvent({ status: '正在读取已上传 PDF 文本...' });
    const pdfText = await pdfService.parsePdfFile(filePath);
    sendEvent({ status: 'PDF 解析完成，正在识别简历字段...' });
    const { data, meta } = await aiService.extractResumeFromTextStream(
      pdfText,
      { model },
      (chunk) => sendEvent({ chunk }),
    );
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, '未能识别出有效简历信息');
      sendEvent({ error: '未能识别出有效简历信息，请检查 PDF 内容后重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data: { resume: data.resume } });
    return res.end();
  } catch (e) {
    if (['CONFIG_MISSING', 'AI_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESUME_TEXT_TOO_SHORT', 'RESUME_JSON_PARSE_FAILED'].includes(e.code)) {
      sendEvent({ error: e.message, code: e.code });
      return res.end();
    }
    await recordAiCall(req, taskType, model, false, e.message);
    sendEvent({ error: `识别失败：${e.message}` });
    return res.end();
  }
}

/** 上传 PDF + JD 流式优化（SSE） */
async function uploadOptimizeByJdStream(req, res) {
  const taskType = 'pdf_jd_optimize';
  const model = getRequestedModel(req);
  upload.single('file')(req, res, async (uploadErr) => {
    const sendEvent = setupSSE(res);
    if (uploadErr) {
      sendEvent({ error: uploadErr.message || '文件上传失败' });
      return res.end();
    }
    if (!req.file) {
      sendEvent({ error: '请上传 PDF 文件（字段名：file）' });
      return res.end();
    }
    const jdText = String(req.body?.jd_text || '').trim();
    if (!jdText) {
      sendEvent({ error: 'jd_text 不能为空' });
      return res.end();
    }
    const filePath = req.file.path;
    try {
      await ensureAiQuota(req, taskType);
      sendEvent({ status: 'PDF 解析完成，AI 正在根据岗位 岗位优化...' });
      const { data, meta } = await parseAndOptimizeByJd(filePath, jdText, model, (chunk) => {
        sendEvent({ chunk });
      });
      if (!data || !data.resume || Object.keys(data.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
        sendEvent({ error: 'AI优化失败，请重试' });
        return res.end();
      }
      await recordAiCall(req, taskType, model, true, '', meta);
      sendEvent({
        done: true,
        data: {
          resume: data.resume,
          optimization_notes: data.optimization_notes || [],
          file_name: req.file.originalname,
          file_size: req.file.size,
        },
      });
      return res.end();
    } catch (e) {
      if (e.code === 'CONFIG_MISSING') {
        sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
        return res.end();
      }
      if (e.code === 'AI_LIMIT_EXCEEDED') {
        sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
        return res.end();
      }
      await recordAiCall(req, taskType, model, false, e.message);
      sendEvent({ error: `处理失败：${e.message}` });
      return res.end();
    }
  });
}

async function existingOptimize(req, res) {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const filePath = pdfService.getUserPdfPath(userId);
  if (!pdfService.getFileMeta(userId)) {
    return error(res, 400, '暂无已上传的简历，请先上传 PDF');
  }
  const targetPosition = req.body?.target_position || '';
  try {
    await ensureAiQuota(req, taskType);
    const { data, meta } = await parseAndOptimize(filePath, targetPosition, model);
    if (!data || !data.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return error(res, 500, 'AI优化失败，请重试');
    }
    const stat = pdfService.getFileMeta(userId);
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, {
      resume: data.resume,
      optimization_notes: data.optimization_notes || [],
      file_name: `${userId}.pdf`,
      file_size: stat.size,
    }, '简历优化完成');
  } catch (e) {
    if (e.code === 'CONFIG_MISSING') return error(res, 400, e.message);
    if (e.code === 'AI_LIMIT_EXCEEDED') return error(res, 403, e.message);
    await recordAiCall(req, taskType, model, false, e.message);
    console.error('[existingOptimize] error:', e);
    return error(res, e.statusCode || 500, `处理失败：${e.message}`);
  }
}

async function existingOptimizeStream(req, res) {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const sendEvent = setupSSE(res);
  const filePath = pdfService.getUserPdfPath(userId);
  if (!pdfService.getFileMeta(userId)) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF' });
    return res.end();
  }
  const targetPosition = req.body?.target_position || '';
  try {
    await ensureAiQuota(req, taskType);
    const pdfText = await pdfService.parsePdfFile(filePath);
    sendEvent({ status: '读取已上传简历，AI 正在优化...' });
    const { data, meta } = await aiService.optimizeFromPdfTextStream(pdfText, targetPosition, { model }, (chunk) => {
      sendEvent({ chunk });
    });
    if (!data || !data.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      sendEvent({ error: 'AI优化失败，请重试' });
      return res.end();
    }
    const stat = pdfService.getFileMeta(userId);
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({
      done: true,
      data: {
        resume: data.resume,
        optimization_notes: data.optimization_notes || [],
        file_name: `${userId}.pdf`,
        file_size: stat.size,
      },
    });
    return res.end();
  } catch (e) {
    if (e.code === 'CONFIG_MISSING') {
      sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
      return res.end();
    }
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, false, e.message);
    sendEvent({ error: `处理失败：${e.message}` });
    return res.end();
  }
}

/** 使用已上传 PDF + JD 流式优化（SSE） */
async function existingOptimizeByJdStream(req, res) {
  const taskType = 'pdf_jd_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const sendEvent = setupSSE(res);
  const filePath = pdfService.getUserPdfPath(userId);
  if (!pdfService.getFileMeta(userId)) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF' });
    return res.end();
  }
  const jdText = String(req.body?.jd_text || '').trim();
  if (!jdText) {
    sendEvent({ error: 'jd_text 不能为空' });
    return res.end();
  }
  try {
    await ensureAiQuota(req, taskType);
    sendEvent({ status: '读取已上传简历，AI 正在根据岗位 岗位优化...' });
    const { data, meta } = await parseAndOptimizeByJd(filePath, jdText, model, (chunk) => {
      sendEvent({ chunk });
    });
    if (!data || !data.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      sendEvent({ error: 'AI优化失败，请重试' });
      return res.end();
    }
    const stat = pdfService.getFileMeta(userId);
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({
      done: true,
      data: {
        resume: data.resume,
        optimization_notes: data.optimization_notes || [],
        file_name: `${userId}.pdf`,
        file_size: stat.size,
      },
    });
    return res.end();
  } catch (e) {
    if (e.code === 'CONFIG_MISSING') {
      sendEvent({ error: e.message, code: 'CONFIG_MISSING' });
      return res.end();
    }
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      sendEvent({ error: e.message, code: 'AI_LIMIT_EXCEEDED' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, false, e.message);
    sendEvent({ error: `处理失败：${e.message}` });
    return res.end();
  }
}

async function uploadedFileMeta(req, res) {
  const meta = pdfService.getFileMeta(req.user.id);
  return success(res, meta);
}

async function deleteUploadedFile(req, res) {
  pdfService.deleteUserPdf(req.user.id);
  return success(res, {}, '已删除上传的简历');
}

module.exports = {
  uploadOptimize,
  uploadOptimizeStream,
  uploadRecognizeStream,
  existingRecognizeStream,
  uploadOptimizeByJdStream,
  existingOptimize,
  existingOptimizeStream,
  existingOptimizeByJdStream,
  uploadedFileMeta,
  deleteUploadedFile,
};
