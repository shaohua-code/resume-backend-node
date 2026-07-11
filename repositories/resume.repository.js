/**
 * 简历数据仓库
 * 封装所有与 PostgreSQL resume 表直接交互的操作
 */

const { dbAdmin } = require('../dbClient');

function serializeResumeJson(resumeJson) {
  if (typeof resumeJson === 'object' && resumeJson !== null) {
    return JSON.stringify(resumeJson);
  }
  return resumeJson || '{}';
}

function buildResumePayload(body) {
  const { title, resume_json, template_id, score } = body || {};
  return {
    title: title || '未命名简历',
    resume_json: serializeResumeJson(resume_json),
    template_id: template_id || 1,
    score: score || 0,
  };
}

async function createResume(userId, body) {
  const now = new Date().toISOString();
  const payload = {
    user_id: userId,
    ...buildResumePayload(body),
    create_time: now,
    update_time: now,
  };
  return dbAdmin.from('resume').insert(payload).select().single();
}

async function updateResume(userId, resumeId, body) {
  const payload = {
    ...buildResumePayload(body),
    update_time: new Date().toISOString(),
  };
  return dbAdmin
    .from('resume')
    .update(payload)
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select()
    .single();
}

async function findById(userId, resumeId) {
  return dbAdmin
    .from('resume')
    .select('*')
    .eq('id', resumeId)
    .eq('user_id', userId)
    .single();
}

async function findByIdAdmin(resumeId) {
  return dbAdmin.from('resume').select('*').eq('id', resumeId).single();
}

async function listByUser(userId, page, size) {
  const from = (page - 1) * size;
  const to = from + size - 1;
  return dbAdmin
    .from('resume')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('update_time', { ascending: false })
    .range(from, to);
}

async function deleteResume(userId, resumeId) {
  return dbAdmin
    .from('resume')
    .delete()
    .eq('id', resumeId)
    .eq('user_id', userId)
    .select();
}

// 批量删除简历（仅删除当前用户的数据）
async function deleteMany(userId, resumeIds) {
  return dbAdmin
    .from('resume')
    .delete()
    .in('id', resumeIds)
    .eq('user_id', userId)
    .select();
}

// 统计当前用户的简历总数（head 模式，不返回数据）
async function countByUser(userId) {
  return dbAdmin
    .from('resume')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
}

// 查询当前用户最早创建的简历（用于超限替换）
async function findOldestByUser(userId) {
  return dbAdmin
    .from('resume')
    .select('id')
    .eq('user_id', userId)
    .order('create_time', { ascending: true })
    .limit(1)
    .single();
}

async function listAdmin({ from, to, userId, userIds }) {
  let query = dbAdmin
    .from('resume')
    .select('id,user_id,title,template_id,score,create_time,update_time', { count: 'exact' })
    .order('update_time', { ascending: false })
    .range(from, to)

  // 普通管理员：仅查询归属用户简历；超管传 null 不过滤
  if (userIds !== undefined && userIds !== null) {
    if (!userIds.length) {
      query = query.eq('user_id', '00000000-0000-0000-0000-000000000000')
    } else {
      query = query.in('user_id', userIds)
    }
  }

  if (userId) query = query.eq('user_id', userId)
  return query
}

module.exports = {
  createResume,
  updateResume,
  findById,
  findByIdAdmin,
  listByUser,
  deleteResume,
  deleteMany,
  countByUser,
  findOldestByUser,
  listAdmin,
};
