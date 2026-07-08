/**
 * 简历控制器
 * 处理简历 CRUD 与导出记录的 HTTP 请求响应
 */

const resumeService = require('../services/resume/resume.service');
const { success, error } = require('../utils/response');

async function create(req, res) {
  try {
    const result = await resumeService.createResume(req.user.id, req.body);
    return success(res, result, '简历已创建');
  } catch (e) {
    return error(res, e.statusCode || 500, e.message, { code: e.code });
  }
}

async function update(req, res) {
  try {
    const result = await resumeService.updateResume(req.user.id, req.params.id, req.body);
    return success(res, result, '简历更新成功');
  } catch (e) {
    return error(res, e.statusCode || 500, e.message, { code: e.code });
  }
}

async function save(req, res) {
  try {
    const result = await resumeService.saveResume(req.user.id, req.body);
    const message = req.body?.id ? '简历更新成功' : '简历保存成功';
    return success(res, result, message);
  } catch (e) {
    return error(res, e.statusCode || 500, e.message, { code: e.code });
  }
}

async function detail(req, res) {
  try {
    const result = await resumeService.getResumeDetail(req.user.id, req.query.resume_id);
    return success(res, result);
  } catch (e) {
    return error(res, e.statusCode || 500, e.message);
  }
}

async function list(req, res) {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const size = parseInt(req.query.size || '10', 10);
    const result = await resumeService.listResumes(req.user.id, page, size);
    return res.json(result);
  } catch (e) {
    return error(res, e.statusCode || 500, e.message);
  }
}

async function remove(req, res) {
  try {
    const resumeId = req.query.resume_id || req.body?.resume_id;
    const result = await resumeService.deleteResume(req.user.id, resumeId);
    return success(res, result, '简历已删除');
  } catch (e) {
    return error(res, e.statusCode || 500, e.message);
  }
}

// 批量删除简历
async function batchRemove(req, res) {
  try {
    const { ids } = req.body || {};
    const result = await resumeService.deleteResumes(req.user.id, ids);
    return success(res, result, result.message);
  } catch (e) {
    return error(res, e.statusCode || 500, e.message);
  }
}

// 获取当前用户简历数量与上限
async function count(req, res) {
  try {
    const result = await resumeService.getResumeCount(req.user.id);
    return success(res, result);
  } catch (e) {
    return error(res, e.statusCode || 500, e.message);
  }
}

async function recordExport(req, res) {
  try {
    const resumeId = req.query.resume_id || req.body?.resume_id;
    const result = await resumeService.recordExport(req.user, resumeId);
    return success(res, result, '导出记录已保存');
  } catch (e) {
    return error(res, e.statusCode || 500, e.message, { code: e.code });
  }
}

module.exports = {
  create,
  update,
  save,
  detail,
  list,
  remove,
  batchRemove,
  count,
  recordExport,
};
