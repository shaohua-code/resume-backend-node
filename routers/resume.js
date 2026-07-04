/**
 * 简历路由模块
 * 数据存储于 Supabase Postgres，通过 supabaseAdmin 客户端操作（绕过 RLS）
 *
 * Supabase 数据表约定：
 * - resume         (id bigint pk, user_id uuid, title text, resume_json text, template_id int, score int, create_time timestamp, update_time timestamp)
 * - export_record  (id bigint pk, user_id uuid, resume_id bigint, create_time timestamp)
 *
 * 注意：user_id 在 Supabase 中是 uuid 类型，对应 auth.users.id
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { supabaseAdmin } = require('../supabaseClient');
const aiService = require('../services/ai_service');
const { authRequired } = require('../middlewares/auth');
const { PERMISSIONS, hasPermission, isAdminRole } = require('../utils/permissions');

const router = express.Router();

function getRequestedModel(req) {
  return (req.body && req.body.model) || req.query.model || '';
}

async function getAiDailyLimit(role) {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', 'ai_daily_limit')
    .single();
  const limitMap = (data && data.config_value) || { USER: 3, VIP: -1 };
  return Number(Object.prototype.hasOwnProperty.call(limitMap, role) ? limitMap[role] : 3);
}

async function ensureAiQuota(req, taskType) {
  if (isAdminRole(req.user.role) || hasPermission(req.user.role, PERMISSIONS.VIP_AI_UNLIMITED)) {
    return;
  }
  const limit = await getAiDailyLimit(req.user.role);
  if (limit < 0) {
    return;
  }
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from('ai_call_record')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('task_type', taskType)
    .gte('create_time', dayStart.toISOString());
  if ((count || 0) >= limit) {
    const err = new Error(`今日${taskType}次数已用完，请升级 VIP 解锁不限次数`);
    err.code = 'AI_LIMIT_EXCEEDED';
    throw err;
  }
}

async function recordAiCall(req, taskType, model, success, errorMessage = '', meta = null) {
  // AI调用日志用于次数限制、后台审计和数据统计，失败也记录便于排查。
  const usage = meta?.usage || {};
  const { error } = await supabaseAdmin.from('ai_call_record').insert({
    user_id: req.user.id,
    task_type: taskType,
    model: meta?.model || model || '',
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    cost: meta?.cost || 0,
    success,
    error_message: errorMessage,
    create_time: new Date().toISOString(),
  });
  // insert 失败时打日志，避免 token/cost 静默丢失
  if (error) {
    console.error('[recordAiCall]', error.message, { taskType, meta });
  }
}

// 上传文件目录：每个用户只保留一份PDF简历
const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// multer 配置：磁盘存储，文件名固定为 <userId>.pdf，新上传自动覆盖旧文件
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const userId = req.user && req.user.id ? req.user.id : 'anonymous';
    cb(null, `${userId}.pdf`);
  },
});

// 仅允许 PDF，最大 10MB
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      return cb(new Error('仅支持 PDF 文件'));
    }
    cb(null, true);
  },
});

// 所有接口都需要登录
router.use(authRequired);

/**
 * AI生成简历接口
 * 调用 DeepSeek 生成专业校招简历内容
 */
router.post('/generate', async (req, res) => {
  const taskType = 'resume_generate';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const userInput = JSON.stringify(req.body || {});
    let callMeta = null;
    const result = await aiService.generateResume(userInput, {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    });
    if (!result || Object.keys(result).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      return res.status(500).json({ detail: 'AI生成简历失败，请重试' });
    }
    await recordAiCall(req, taskType, model, true, '', callMeta);
    return res.json({ success: true, data: result });
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return res.status(403).json({ detail: e.message });
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      return res.status(400).json({ detail: e.message });
    }
    return res.status(500).json({ detail: `AI服务调用失败：${e.message}` });
  }
});

/**
 * AI生成简历接口（SSE 流式）
 * 前端通过 fetch 读取 data: {...} 行，done 事件携带解析后的 JSON
 */
router.post('/generate/stream', async (req, res) => {
  const taskType = 'resume_generate';
  const model = getRequestedModel(req);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sendEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await ensureAiQuota(req, taskType);
    const userInput = JSON.stringify(req.body || {});
    let callMeta = null;
    const result = await aiService.generateResumeStream(userInput, {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    }, (chunk) => {
      sendEvent({ chunk });
    });
    if (!result || Object.keys(result).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI生成简历失败，请重试');
      sendEvent({ error: 'AI生成简历失败，请重试' });
      return res.end();
    }
    await recordAiCall(req, taskType, model, true, '', callMeta);
    sendEvent({ done: true, data: result });
    res.end();
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
    res.end();
  }
});

/**
 * AI优化项目描述接口
 */
router.post('/optimize', async (req, res) => {
  const taskType = 'project_optimize';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const { project_description, target_position } = req.body || {};
    if (!project_description) {
      return res.status(400).json({ detail: 'project_description 不能为空' });
    }
    let callMeta = null;
    const result = await aiService.optimizeProject(project_description, target_position || '', {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    });
    if (!result || Object.keys(result).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return res.status(500).json({ detail: 'AI优化失败，请重试' });
    }
    await recordAiCall(req, taskType, model, true, '', callMeta);
    return res.json({ success: true, data: result });
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return res.status(403).json({ detail: e.message });
    }
    await recordAiCall(req, taskType, model, false, e.message);
    if (e.code === 'CONFIG_MISSING') {
      return res.status(400).json({ detail: e.message });
    }
    return res.status(500).json({ detail: `AI服务调用失败：${e.message}` });
  }
});

/**
 * JD岗位匹配分析接口
 */
router.post('/match', async (req, res) => {
  const taskType = 'jd_match';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const { resume_id, jd_text } = req.body || {};
    const { data: resume, error } = await supabaseAdmin
      .from('resume')
      .select('*')
      .eq('id', resume_id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !resume) {
      return res.status(404).json({ detail: '简历不存在' });
    }
    let callMeta = null;
    const matchData = await aiService.matchJd(resume.resume_json, jd_text || '', {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    });
    await recordAiCall(req, taskType, model, true, '', callMeta);
    return res.json({ success: true, data: matchData, message: '匹配分析完成' });
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return res.status(403).json({ detail: e.message });
    }
    await recordAiCall(req, taskType, model, false, e.message);
    return res.status(500).json({ detail: `AI服务调用失败：${e.message}` });
  }
});

/**
 * AI简历评分接口
 */
router.post('/score', async (req, res) => {
  const taskType = 'score';
  const model = getRequestedModel(req);
  try {
    await ensureAiQuota(req, taskType);
    const resumeId = req.query.resume_id || (req.body && req.body.resume_id);
    const { data: resume, error } = await supabaseAdmin
      .from('resume')
      .select('*')
      .eq('id', resumeId)
      .eq('user_id', req.user.id)
      .single();
    if (error || !resume) {
      return res.status(404).json({ detail: '简历不存在' });
    }
    let callMeta = null;
    const scoreData = await aiService.scoreResume(resume.resume_json, {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    });
    await recordAiCall(req, taskType, model, true, '', callMeta);
    return res.json({ success: true, data: scoreData, message: '评分完成' });
  } catch (e) {
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return res.status(403).json({ detail: e.message });
    }
    await recordAiCall(req, taskType, model, false, e.message);
    return res.status(500).json({ detail: `AI服务调用失败：${e.message}` });
  }
});

/**
 * 创建简历接口
 * AI 生成、上传优化、首次保存时使用，仅做 insert
 */
router.post('/create', async (req, res) => {
  const userId = req.user.id;
  const { title, resume_json, template_id, score } = req.body || {};
  const now = new Date().toISOString();

  let resumeJsonStr = resume_json;
  if (typeof resumeJsonStr === 'object' && resumeJsonStr !== null) {
    resumeJsonStr = JSON.stringify(resumeJsonStr);
  }

  const payload = {
    user_id: userId,
    title: title || '未命名简历',
    resume_json: resumeJsonStr || '{}',
    template_id: template_id || 1,
    score: score || 0,
    create_time: now,
    update_time: now,
  };

  const { data, error, status, statusText } = await supabaseAdmin
    .from('resume')
    .insert(payload)
    .select()
    .single();

  console.log('[create] Supabase 返回 status =', status, statusText);
  if (error) {
    console.error('[create] Supabase error =', error);
    return res.status(500).json({ detail: `创建失败：${error.message}`, code: error.code, hint: error.hint });
  }
  console.log('[create] 写入成功，data =', data);
  return res.json({ success: true, data: { id: data.id }, message: '简历已创建' });
});

/**
 * 更新简历接口
 * id 必传，仅做 update
 */
router.put('/update/:id', async (req, res) => {
  const userId = req.user.id;
  const resumeId = req.params.id;
  const { title, resume_json, template_id, score } = req.body || {};
  const now = new Date().toISOString();

  let resumeJsonStr = resume_json;
  if (typeof resumeJsonStr === 'object' && resumeJsonStr !== null) {
    resumeJsonStr = JSON.stringify(resumeJsonStr);
  }

  const payload = {
    title: title || '未命名简历',
    resume_json: resumeJsonStr || '{}',
    template_id: template_id || 1,
    score: score || 0,
    update_time: now,
  };

  const { data, error, status, statusText } = await supabaseAdmin
    .from('resume')
    .update(payload)
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select()
    .single();

  console.log('[update] id =', resumeId, 'status =', status, statusText);
  if (error) {
    console.error('[update] Supabase error =', error);
    return res.status(500).json({ detail: `更新失败：${error.message}`, code: error.code, hint: error.hint });
  }
  if (!data) {
    return res.status(404).json({ detail: '简历不存在或无权更新' });
  }
  return res.json({ success: true, data: { id: data.id }, message: '简历更新成功' });
});

/**
 * 保存简历接口（兼容旧调用）
 * 如果传了 id 则更新已有简历，否则创建新简历
 */
router.post('/save', async (req, res) => {
  const userId = req.user.id;
  const { id, title, resume_json, template_id, score } = req.body || {};
  const now = new Date().toISOString();

  // resume_json 必须是字符串；如果前端传了对象，这里自动序列化
  let resumeJsonStr = resume_json;
  if (typeof resumeJsonStr === 'object' && resumeJsonStr !== null) {
    resumeJsonStr = JSON.stringify(resumeJsonStr);
  }

  const payload = {
    title: title || '未命名简历',
    resume_json: resumeJsonStr || '{}',
    template_id: template_id || 1,
    score: score || 0,
    update_time: now,
  };

  let data, error, status, statusText;

  if (id) {
    // 更新已有简历
    console.log('[save] 更新简历 id =', id, 'user_id =', userId);
    const result = await supabaseAdmin
      .from('resume')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    data = result.data;
    error = result.error;
    status = result.status;
    statusText = result.statusText;
  } else {
    // 创建新简历
    console.log('[save] 新建简历 user_id =', userId);
    const result = await supabaseAdmin
      .from('resume')
      .insert({
        ...payload,
        user_id: userId,
        create_time: now,
      })
      .select()
      .single();
    data = result.data;
    error = result.error;
    status = result.status;
    statusText = result.statusText;
  }

  console.log('[save] Supabase 返回 status =', status, statusText);
  if (error) {
    console.error('[save] Supabase error =', error);
    return res.status(500).json({ detail: `保存失败：${error.message}`, code: error.code, hint: error.hint });
  }
  console.log('[save] 写入成功，data =', data);
  return res.json({ success: true, data: { id: data.id }, message: id ? '简历更新成功' : '简历保存成功' });
});

/**
 * 获取简历列表接口
 * 分页返回当前用户的所有简历
 */
router.get('/list', async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page || '1', 10);
  const size = parseInt(req.query.size || '10', 10);
  const from = (page - 1) * size;
  const to = from + size - 1;

  // count: 'exact' 返回总数；range 实现分页
  const { data, error, count } = await supabaseAdmin
    .from('resume')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('update_time', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(500).json({ detail: `查询失败：${error.message}` });
  }

  const items = (data || []).map((r) => ({
    id: r.id,
    title: r.title,
    resume_json: r.resume_json,
    template_id: r.template_id,
    score: r.score,
    create_time: String(r.create_time),
    update_time: String(r.update_time),
  }));
  return res.json({ total: count || 0, items });
});

/**
 * 获取简历详情接口
 */
router.get('/detail', async (req, res) => {
  const userId = req.user.id;
  const resumeId = req.query.resume_id;
  const { data: resume, error } = await supabaseAdmin
    .from('resume')
    .select('*')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .single();
  if (error || !resume) {
    return res.status(404).json({ detail: '简历不存在' });
  }
  return res.json({
    id: resume.id,
    title: resume.title,
    resume_json: resume.resume_json,
    template_id: resume.template_id,
    score: resume.score,
    create_time: String(resume.create_time),
    update_time: String(resume.update_time),
  });
});

/**
 * 删除简历接口
 * 仅能删除自己的简历
 */
router.delete('/delete', async (req, res) => {
  const userId = req.user.id;
  const resumeId = req.query.resume_id || (req.body && req.body.resume_id);
  const { data, error } = await supabaseAdmin
    .from('resume')
    .delete()
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select();
  if (error) {
    return res.status(500).json({ detail: `删除失败：${error.message}` });
  }
  if (!data || data.length === 0) {
    return res.status(404).json({ detail: '简历不存在或无权删除' });
  }
  return res.json({ success: true, message: '简历已删除' });
});

/**
 * 记录导出操作接口
 */
router.post('/export', async (req, res) => {
  const userId = req.user.id;
  const resumeId = req.query.resume_id || (req.body && req.body.resume_id);
  if (!hasPermission(req.user.role, PERMISSIONS.VIP_EXPORT)) {
    return res.status(403).json({ detail: '普通用户暂不支持导出，请升级 VIP 后使用' });
  }

  // 验证简历存在
  const { data: resume } = await supabaseAdmin
    .from('resume')
    .select('id')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .single();
  if (!resume) {
    return res.status(404).json({ detail: '简历不存在' });
  }

  const { error } = await supabaseAdmin.from('export_record').insert({
    user_id: userId,
    resume_id: resumeId,
    create_time: new Date().toISOString(),
  });
  if (error) {
    return res.status(500).json({ detail: `记录失败：${error.message}` });
  }
  return res.json({ success: true, message: '导出记录已保存' });
});

/**
 * 上传 PDF 并由 AI 流式优化（SSE）
 */
router.post('/uploadOptimize/stream', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    const taskType = 'pdf_optimize';
    const model = getRequestedModel(req);
    if (uploadErr) {
      return res.status(400).json({ detail: uploadErr.message || '文件上传失败' });
    }
    if (!req.file) {
      return res.status(400).json({ detail: '请上传 PDF 文件（字段名：file）' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sendEvent = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const filePath = req.file.path;
    const targetPosition = (req.body && req.body.target_position) || '';

    try {
      await ensureAiQuota(req, taskType);
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      const pdfText = (pdfData.text || '').trim();

      if (!pdfText) {
        sendEvent({ error: 'PDF 内容为空或无法解析（可能是扫描版图片PDF）' });
        return res.end();
      }

      sendEvent({ status: 'PDF 解析完成，AI 正在优化...' });
      const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) : pdfText;

      let callMeta = null;
      const result = await aiService.optimizeFromPdfTextStream(
        truncated,
        targetPosition,
        {
          model,
          onCallMeta: (meta) => { callMeta = meta; },
        },
        (chunk) => sendEvent({ chunk }),
      );

      if (!result || !result.resume || Object.keys(result.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
        sendEvent({ error: 'AI优化失败，请重试' });
        return res.end();
      }

      await recordAiCall(req, taskType, model, true, '', callMeta);
      sendEvent({
        done: true,
        data: {
          resume: result.resume,
          optimization_notes: result.optimization_notes || [],
          file_name: req.file.originalname,
          file_size: req.file.size,
        },
      });
      res.end();
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
      res.end();
    }
  });
});

/**
 * 上传 PDF 简历并由 AI 整体优化
 * 路径：POST /api/resume/uploadOptimize
 * 表单字段：file=简历PDF, target_position=目标岗位（可选）
 *
 * 行为：
 * 1. 仅允许 PDF，<= 10MB
 * 2. 文件保存为 uploads/<userId>.pdf，每个用户只保留一份（新上传覆盖旧的）
 * 3. 解析 PDF 文本 → 调用 DeepSeek 整体重写为结构化简历 JSON
 * 4. 返回优化后的简历 JSON 和优化要点列表
 */
router.post('/uploadOptimize', (req, res) => {
  // 这里手动调用 multer，便于在 fileFilter 报错时也返回 JSON
  upload.single('file')(req, res, async (uploadErr) => {
    const taskType = 'pdf_optimize';
    const model = getRequestedModel(req);
    if (uploadErr) {
      return res.status(400).json({ detail: uploadErr.message || '文件上传失败' });
    }
    if (!req.file) {
      return res.status(400).json({ detail: '请上传 PDF 文件（字段名：file）' });
    }

    const filePath = req.file.path;
    const targetPosition = (req.body && req.body.target_position) || '';

    try {
      await ensureAiQuota(req, taskType);
      // 1. 解析 PDF 文本
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      const pdfText = (pdfData.text || '').trim();

      if (!pdfText) {
        return res.status(400).json({ detail: 'PDF 内容为空或无法解析（可能是扫描版图片PDF）' });
      }

      // 限制送入AI的文本长度，避免超过 token 上限
      const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) : pdfText;

      // 2. 调用 AI 整体优化
      let callMeta = null;
      const result = await aiService.optimizeFromPdfText(truncated, targetPosition, {
        model,
        onCallMeta: (meta) => { callMeta = meta; },
      });

      if (!result || !result.resume || Object.keys(result.resume).length === 0) {
        await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
        return res.status(500).json({ detail: 'AI优化失败，请重试' });
      }

      await recordAiCall(req, taskType, model, true, '', callMeta);
      return res.json({
        success: true,
        data: {
          resume: result.resume,
          optimization_notes: result.optimization_notes || [],
          file_name: req.file.originalname,
          file_size: req.file.size,
        },
        message: '简历优化完成',
      });
    } catch (e) {
      if (e.code === 'CONFIG_MISSING') {
        return res.status(400).json({ detail: e.message });
      }
      if (e.code === 'AI_LIMIT_EXCEEDED') {
        return res.status(403).json({ detail: e.message });
      }
      await recordAiCall(req, taskType, model, false, e.message);
      console.error('[uploadOptimize] error:', e);
      return res.status(500).json({ detail: `处理失败：${e.message}` });
    }
  });
});

/**
 * 使用已上传的 PDF 进行 AI 流式优化（无需重新上传）
 */
router.post('/uploadOptimize/existing/stream', async (req, res) => {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const filePath = path.join(UPLOAD_DIR, `${userId}.pdf`);

  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ detail: '暂无已上传的简历，请先上传 PDF' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sendEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const targetPosition = (req.body && req.body.target_position) || '';

  try {
    await ensureAiQuota(req, taskType);
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    const pdfText = (pdfData.text || '').trim();

    if (!pdfText) {
      sendEvent({ error: 'PDF 内容为空或无法解析（可能是扫描版图片PDF）' });
      return res.end();
    }

    sendEvent({ status: '读取已上传简历，AI 正在优化...' });
    const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) : pdfText;

    let callMeta = null;
    const result = await aiService.optimizeFromPdfTextStream(
      truncated,
      targetPosition,
      {
        model,
        onCallMeta: (meta) => { callMeta = meta; },
      },
      (chunk) => sendEvent({ chunk }),
    );

    if (!result || !result.resume || Object.keys(result.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      sendEvent({ error: 'AI优化失败，请重试' });
      return res.end();
    }

    const stat = fs.statSync(filePath);
    await recordAiCall(req, taskType, model, true, '', callMeta);
    sendEvent({
      done: true,
      data: {
        resume: result.resume,
        optimization_notes: result.optimization_notes || [],
        file_name: `${userId}.pdf`,
        file_size: stat.size,
      },
    });
    res.end();
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
    res.end();
  }
});

/**
 * 使用已上传的 PDF 进行 AI 同步优化
 */
router.post('/uploadOptimize/existing', async (req, res) => {
  const taskType = 'pdf_optimize';
  const model = getRequestedModel(req);
  const userId = req.user.id;
  const filePath = path.join(UPLOAD_DIR, `${userId}.pdf`);

  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ detail: '暂无已上传的简历，请先上传 PDF' });
  }

  const targetPosition = (req.body && req.body.target_position) || '';

  try {
    await ensureAiQuota(req, taskType);
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    const pdfText = (pdfData.text || '').trim();

    if (!pdfText) {
      return res.status(400).json({ detail: 'PDF 内容为空或无法解析（可能是扫描版图片PDF）' });
    }

    const truncated = pdfText.length > 8000 ? pdfText.slice(0, 8000) : pdfText;
    let callMeta = null;
    const result = await aiService.optimizeFromPdfText(truncated, targetPosition, {
      model,
      onCallMeta: (meta) => { callMeta = meta; },
    });

    if (!result || !result.resume || Object.keys(result.resume).length === 0) {
      await recordAiCall(req, taskType, model, false, 'AI优化失败，请重试');
      return res.status(500).json({ detail: 'AI优化失败，请重试' });
    }

    const stat = fs.statSync(filePath);
    await recordAiCall(req, taskType, model, true, '', callMeta);
    return res.json({
      success: true,
      data: {
        resume: result.resume,
        optimization_notes: result.optimization_notes || [],
        file_name: `${userId}.pdf`,
        file_size: stat.size,
      },
      message: '简历优化完成',
    });
  } catch (e) {
    if (e.code === 'CONFIG_MISSING') {
      return res.status(400).json({ detail: e.message });
    }
    if (e.code === 'AI_LIMIT_EXCEEDED') {
      return res.status(403).json({ detail: e.message });
    }
    await recordAiCall(req, taskType, model, false, e.message);
    console.error('[uploadOptimize/existing] error:', e);
    return res.status(500).json({ detail: `处理失败：${e.message}` });
  }
});

/**
 * 获取当前用户已上传的 PDF 元信息
 * 路径：GET /api/resume/uploadedFile
 */
router.get('/uploadedFile', (req, res) => {
  const userId = req.user.id;
  const filePath = path.join(UPLOAD_DIR, `${userId}.pdf`);
  if (!fs.existsSync(filePath)) {
    return res.json({ success: true, data: null });
  }
  const stat = fs.statSync(filePath);
  return res.json({
    success: true,
    data: {
      size: stat.size,
      mtime: stat.mtime,
    },
  });
});

/**
 * 删除当前用户已上传的 PDF
 * 路径：DELETE /api/resume/uploadedFile
 */
router.delete('/uploadedFile', (req, res) => {
  const userId = req.user.id;
  const filePath = path.join(UPLOAD_DIR, `${userId}.pdf`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return res.json({ success: true, message: '已删除上传的简历' });
});

module.exports = router;
