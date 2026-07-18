/**
 * 简历业务服务
 * 处理简历 CRUD 的业务逻辑，调用 resume.repository 访问数据
 */

const resumeRepo = require('../../repositories/resume.repository');
const { dbAdmin } = require('../../dbClient');

// 每位用户最多可保存的简历数量
const MAX_RESUME_COUNT = 5;

function mapResumeItem(r) {
  return {
    id: r.id,
    title: r.title,
    resume_json: r.resume_json,
    template_id: r.template_id,
    score: r.score,
    create_time: String(r.create_time),
    update_time: String(r.update_time),
  };
}

async function createResume(userId, body) {
  // 超限替换与创建由仓储在同一事务中完成，避免并发突破上限或先删后建失败。
  const { data, error } = await resumeRepo.createWithinLimit(userId, body, MAX_RESUME_COUNT);
  if (error) {
    console.error('[create] 数据库 error =', error);
    throw Object.assign(new Error(`创建失败：${error.message}`), { code: error.code, statusCode: 500 });
  }
  return { id: data.id };
}

async function updateResume(userId, resumeId, body) {
  const { data, error } = await resumeRepo.updateResume(userId, resumeId, body);
  if (error) {
    console.error('[update] 数据库 error =', error);
    throw Object.assign(new Error(`更新失败：${error.message}`), { code: error.code, statusCode: 500 });
  }
  if (!data) {
    throw Object.assign(new Error('简历不存在或无权更新'), { statusCode: 404 });
  }
  return { id: data.id };
}

async function saveResume(userId, body) {
  const { id, title, resume_json, template_id, score, client_request_id } = body || {};
  if (id) {
    return updateResume(userId, id, { title, resume_json, template_id, score });
  }
  // 兼容保存入口的首次创建也透传幂等键，与 /resume/create 保持相同重试语义。
  return createResume(userId, { title, resume_json, template_id, score, client_request_id });
}

async function getResumeDetail(userId, resumeId) {
  const { data: resume, error } = await resumeRepo.findById(userId, resumeId);
  if (error || !resume) {
    throw Object.assign(new Error('简历不存在'), { statusCode: 404 });
  }
  return mapResumeItem(resume);
}

async function listResumes(userId, page, size) {
  const { data, error, count } = await resumeRepo.listByUser(userId, page, size);
  if (error) {
    throw Object.assign(new Error(`查询失败：${error.message}`), { statusCode: 500 });
  }
  return { total: count || 0, items: (data || []).map(mapResumeItem) };
}

async function deleteResume(userId, resumeId) {
  const { data, error } = await resumeRepo.deleteResume(userId, resumeId);
  if (error) {
    throw Object.assign(new Error(`删除失败：${error.message}`), { statusCode: 500 });
  }
  if (!data || data.length === 0) {
    throw Object.assign(new Error('简历不存在或无权删除'), { statusCode: 404 });
  }
  return { message: '简历已删除' };
}

// 批量删除简历
async function deleteResumes(userId, resumeIds) {
  if (!Array.isArray(resumeIds) || resumeIds.length === 0) {
    throw Object.assign(new Error('请选择要删除的简历'), { statusCode: 400 });
  }
  const { data, error } = await resumeRepo.deleteMany(userId, resumeIds);
  if (error) {
    throw Object.assign(new Error(`批量删除失败：${error.message}`), { statusCode: 500 });
  }
  return { deleted: (data || []).length, message: `已删除 ${(data || []).length} 份简历` };
}

// 获取当前用户简历数量与上限
async function getResumeCount(userId) {
  const { count, error } = await resumeRepo.countByUser(userId);
  if (error) {
    throw Object.assign(new Error(`查询简历数量失败：${error.message}`), { statusCode: 500 });
  }
  return { count: count || 0, max: MAX_RESUME_COUNT };
}

async function recordExport(user, resumeId) {
  const { data: resume } = await resumeRepo.findById(user.id, resumeId);
  if (!resume) {
    throw Object.assign(new Error('简历不存在'), { statusCode: 404 });
  }
  const { error } = await dbAdmin.from('export_record').insert({
    user_id: user.id,
    resume_id: resumeId,
    create_time: new Date().toISOString(),
  });
  if (error) {
    throw Object.assign(new Error(`记录失败：${error.message}`), { statusCode: 500 });
  }
  return { message: '导出记录已保存' };
}

module.exports = {
  createResume,
  updateResume,
  saveResume,
  getResumeDetail,
  listResumes,
  deleteResume,
  deleteResumes,
  getResumeCount,
  recordExport,
};
