/**
 * 简历业务服务
 * 处理简历 CRUD 的业务逻辑，调用 resume.repository 访问数据
 */

const resumeRepo = require('../../repositories/resume.repository');
const { supabaseAdmin } = require('../../supabaseClient');

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
  // 数量限制：超过上限时自动删除最早创建的简历
  const { count, error: countError } = await resumeRepo.countByUser(userId);
  if (countError) {
    throw Object.assign(new Error(`查询简历数量失败：${countError.message}`), { statusCode: 500 });
  }
  if (count >= MAX_RESUME_COUNT) {
    // 删除最早创建的简历，腾出名额
    const { data: oldest, error: oldestError } = await resumeRepo.findOldestByUser(userId);
    if (oldestError || !oldest) {
      throw Object.assign(new Error('替换旧简历失败，请先手动删除后再创建'), { statusCode: 500 });
    }
    const { error: delError } = await resumeRepo.deleteResume(userId, oldest.id);
    if (delError) {
      throw Object.assign(new Error(`替换旧简历失败：${delError.message}`), { statusCode: 500 });
    }
    console.log('[create] 简历数量超限，已删除最早简历 id =', oldest.id);
  }

  const { data, error, status, statusText } = await resumeRepo.createResume(userId, body);
  console.log('[create] Supabase 返回 status =', status, statusText);
  if (error) {
    console.error('[create] Supabase error =', error);
    throw Object.assign(new Error(`创建失败：${error.message}`), { code: error.code, statusCode: 500 });
  }
  console.log('[create] 写入成功，data =', data);
  return { id: data.id };
}

async function updateResume(userId, resumeId, body) {
  const { data, error, status, statusText } = await resumeRepo.updateResume(userId, resumeId, body);
  console.log('[update] id =', resumeId, 'status =', status, statusText);
  if (error) {
    console.error('[update] Supabase error =', error);
    throw Object.assign(new Error(`更新失败：${error.message}`), { code: error.code, statusCode: 500 });
  }
  if (!data) {
    throw Object.assign(new Error('简历不存在或无权更新'), { statusCode: 404 });
  }
  return { id: data.id };
}

async function saveResume(userId, body) {
  const { id, title, resume_json, template_id, score } = body || {};
  if (id) {
    console.log('[save] 更新简历 id =', id, 'user_id =', userId);
    return updateResume(userId, id, { title, resume_json, template_id, score });
  }
  console.log('[save] 新建简历 user_id =', userId);
  return createResume(userId, { title, resume_json, template_id, score });
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
  const { error } = await supabaseAdmin.from('export_record').insert({
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
