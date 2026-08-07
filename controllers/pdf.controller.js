/**
 * PDF / Word 简历源文件控制器
 * 处理上传、事实识别、AI 优化（同步/流式）以及文件管理
 */

const aiService = require('../services/ai/ai.service');
const pdfService = require('../services/pdf/pdf.service');
const { ensureAiQuota, recordAiCall } = require('../services/ai/ai.quota.service');
const { success, error } = require('../utils/response');

const upload = pdfService.buildMulterConfig();

function getRequestedModel(req) {
  return (req.body && req.body.model) || req.query.model || '';
}

function getAiOptions(req) {
  return { model: getRequestedModel(req), userId: req.user && req.user.id };
}

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function parseAndOptimize(filePath, targetPosition, aiOptions, onChunk = null) {
  const pdfText = await pdfService.parsePdfFile(filePath);
  if (onChunk) {
    return aiService.optimizeFromPdfTextStream(pdfText, targetPosition, aiOptions, onChunk);
  }
  return aiService.optimizeFromPdfText(pdfText, targetPosition, aiOptions);
}

/** PDF 原文 + JD 联合流式优化 */
async function parseAndOptimizeByJd(filePath, jdText, aiOptions, onChunk) {
  const pdfText = await pdfService.parsePdfFile(filePath);
  return aiService.optimizePdfByJdStream(pdfText, jdText, aiOptions, onChunk);
}

async function uploadOptimize(req, res) {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return error(res, 400, uploadErr.message || '文件上传失败');
    }
    if (!req.file) {
      return error(res, 400, '请上传 PDF 或 Word（.docx）文件（字段名：file）');
    }
    const filePath = req.file.path;
    const targetPosition = req.body?.target_position || '';
    try {
      await ensureAiQuota(req, taskType);
      const { data, meta } = await parseAndOptimize(filePath, targetPosition, getAiOptions(req));
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
      sendEvent({ error: '请上传 PDF 或 Word（.docx）文件（字段名：file）' });
      return res.end();
    }
    const filePath = req.file.path;
    const targetPosition = req.body?.target_position || '';
    try {
      await ensureAiQuota(req, taskType);
      const pdfText = await pdfService.parsePdfFile(filePath);
      sendEvent({ status: '文件解析完成，AI 正在优化...' });
      const { data, meta } = await aiService.optimizeFromPdfTextStream(pdfText, targetPosition, getAiOptions(req), (chunk) => {
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
 * 上传 PDF/Word 并流式识别结构化表单字段。
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
      sendEvent({ error: '请上传 PDF 或 Word（.docx）文件（字段名：file）' });
      return res.end();
    }

    // multipart 字段只有在 multer 完成后才可读取，避免忽略前端传入的模型。
    const model = getRequestedModel(req);
    try {
      await ensureAiQuota(req, taskType);
      sendEvent({ status: '正在解析简历文件文本...' });
      const pdfText = await pdfService.parsePdfFile(req.file.path);
      sendEvent({ status: '文件解析完成，正在识别简历字段...' });
      const { data, meta } = await aiService.extractResumeFromTextStream(
        pdfText,
        getAiOptions(req),
        (chunk) => sendEvent({ chunk }),
      );
      if (!data?.resume || Object.keys(data.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, '未能识别出有效简历信息');
        sendEvent({ error: '未能识别出有效简历信息，请检查文件内容后重试' });
        return res.end();
      }

      await recordAiCall(req, taskType, model, true, '', meta);
      sendEvent({ done: true, data: { resume: data.resume } });
      return res.end();
    } catch (e) {
      if (['CONFIG_MISSING', 'AI_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESUME_TEXT_TOO_SHORT', 'RESUME_JSON_PARSE_FAILED', 'RESUME_JSON_TRUNCATED'].includes(e.code)) {
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
 * 使用已上传简历源文件流式纯识别（SSE），无需重新上传。
 * 与 uploadRecognizeStream 共用 resume_extract，不做润色或优化。
 */
async function existingRecognizeStream(req, res) {
  const taskType = 'resume_extract';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const sendEvent = setupSSE(res);
  const found = pdfService.findUserResumeFile(userId);
  if (!found) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF 或 Word（.docx）' });
    return res.end();
  }
  try {
    await ensureAiQuota(req, taskType);
    sendEvent({ status: '正在读取已上传简历文件...' });
    const pdfText = await pdfService.parsePdfFile(found.filePath);
    sendEvent({ status: '文件解析完成，正在识别简历字段...' });
    const { data, meta } = await aiService.extractResumeFromTextStream(
      pdfText,
      getAiOptions(req),
      (chunk) => sendEvent({ chunk }),
    );
    if (!data?.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, '未能识别出有效简历信息');
      sendEvent({ error: '未能识别出有效简历信息，请检查文件内容后重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', meta);
    sendEvent({ done: true, data: { resume: data.resume } });
    return res.end();
  } catch (e) {
    if (['CONFIG_MISSING', 'AI_LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESUME_TEXT_TOO_SHORT', 'RESUME_JSON_PARSE_FAILED', 'RESUME_JSON_TRUNCATED'].includes(e.code)) {
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
      sendEvent({ error: '请上传 PDF 或 Word（.docx）文件（字段名：file）' });
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
      sendEvent({ status: '文件解析完成，AI 正在根据岗位优化...' });
      const { data, meta } = await parseAndOptimizeByJd(filePath, jdText, getAiOptions(req), (chunk) => {
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
  const found = pdfService.findUserResumeFile(userId);
  if (!found) {
    return error(res, 400, '暂无已上传的简历，请先上传 PDF 或 Word（.docx）');
  }
  const targetPosition = req.body?.target_position || '';
  try {
    await ensureAiQuota(req, taskType);
    const { data, meta } = await parseAndOptimize(found.filePath, targetPosition, getAiOptions(req));
    if (!data || !data.resume || Object.keys(data.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return error(res, 500, 'AI优化失败，请重试');
    }
    const stat = pdfService.getFileMeta(userId);
    await recordAiCall(req, taskType, model, true, '', meta);
    return success(res, {
      resume: data.resume,
      optimization_notes: data.optimization_notes || [],
      file_name: stat?.filename || `${userId}${found.ext}`,
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
  const found = pdfService.findUserResumeFile(userId);
  if (!found) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF 或 Word（.docx）' });
    return res.end();
  }
  const targetPosition = req.body?.target_position || '';
  try {
    await ensureAiQuota(req, taskType);
    const pdfText = await pdfService.parsePdfFile(found.filePath);
    sendEvent({ status: '读取已上传简历，AI 正在优化...' });
    const { data, meta } = await aiService.optimizeFromPdfTextStream(pdfText, targetPosition, getAiOptions(req), (chunk) => {
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
        file_name: stat?.filename || `${userId}${found.ext}`,
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

/** 使用已上传简历源文件 + JD 流式优化（SSE） */
async function existingOptimizeByJdStream(req, res) {
  const taskType = 'pdf_jd_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const sendEvent = setupSSE(res);
  const found = pdfService.findUserResumeFile(userId);
  if (!found) {
    sendEvent({ error: '暂无已上传的简历，请先上传 PDF 或 Word（.docx）' });
    return res.end();
  }
  const jdText = String(req.body?.jd_text || '').trim();
  if (!jdText) {
    sendEvent({ error: 'jd_text 不能为空' });
    return res.end();
  }
  try {
    await ensureAiQuota(req, taskType);
    sendEvent({ status: '读取已上传简历，AI 正在根据岗位优化...' });
    const { data, meta } = await parseAndOptimizeByJd(found.filePath, jdText, getAiOptions(req), (chunk) => {
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
        file_name: stat?.filename || `${userId}${found.ext}`,
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

/**
 * 返回当前用户私有简历源文件；PDF 可 inline 预览，Word 以附件下载。
 */
async function uploadedFileContent(req, res) {
  const fs = require('fs');
  const found = pdfService.findUserResumeFile(req.user.id);
  if (!found) {
    return error(res, 404, '尚未上传简历文件');
  }
  const headers = pdfService.getResumeContentHeaders(found.filePath);
  res.setHeader('Content-Type', headers.contentType);
  res.setHeader('Content-Disposition', headers.disposition);
  res.setHeader('Cache-Control', 'private, no-store');
  return fs.createReadStream(found.filePath).pipe(res);
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
  uploadedFileContent,
  deleteUploadedFile,
};
