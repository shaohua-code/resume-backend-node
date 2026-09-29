/**
 * 简历数据仓库
 * 封装所有与 PostgreSQL resume 表直接交互的操作
 */

const { dbAdmin } = require('../dbClient');
const db = require('../lib/db');
const DEFAULT_TEMPLATE_ID = 56;
const MAX_TEMPLATE_ID = 60;

function serializeResumeJson(resumeJson) {
  if (typeof resumeJson === 'object' && resumeJson !== null) {
    return JSON.stringify(resumeJson);
  }
  return resumeJson || '{}';
}

// API 的模板号限制在注册表的有效范围，缺失或越界时与前端采用相同默认款。
function normalizeTemplateId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 && id <= MAX_TEMPLATE_ID ? id : DEFAULT_TEMPLATE_ID;
}

function buildResumePayload(body) {
  const { title, resume_json, template_id, score } = body || {};
  return {
    title: title || '未命名简历',
    resume_json: serializeResumeJson(resume_json),
    // 有效模板 ID 原样持久化，缺失或无效值回退到与前端一致的默认款。
    template_id: normalizeTemplateId(template_id),
    score: score || 0,
  };
}

/** 规范化可选的客户端保存幂等键；更新接口不会覆盖既有键。 */
function getClientRequestId(body) {
  const value = String(body?.client_request_id || '').trim();
  return value || null;
}

async function createResume(userId, body) {
  const now = new Date().toISOString();
  const payload = {
    user_id: userId,
    ...buildResumePayload(body),
    client_request_id: getClientRequestId(body),
    create_time: now,
    update_time: now,
  };
  return dbAdmin.from('resume').insert(payload).select().single();
}

/**
 * 在单事务和用户级数据库锁内执行“超限替换 + 创建”。
 * 这样并发生成既不会突破五份上限，也不会在新记录创建失败时提前丢掉旧简历。
 */
async function createWithinLimit(userId, body, maxCount) {
  const client = await db.getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`resume-limit:${userId}`]);

    const clientRequestId = getClientRequestId(body);
    if (clientRequestId) {
      const { rows: idempotentRows } = await client.query(
        `SELECT * FROM public.resume
         WHERE user_id = $1 AND client_request_id = $2
         LIMIT 1`,
        [userId, clientRequestId],
      );
      if (idempotentRows.length) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { data: idempotentRows[0], error: null, idempotent: true };
      }
    }

    const { rows: existingRows } = await client.query(
      `SELECT id
       FROM public.resume
       WHERE user_id = $1
       ORDER BY create_time ASC, id ASC`,
      [userId],
    );
    const deleteCount = Math.max(0, existingRows.length - Number(maxCount) + 1);
    if (deleteCount > 0) {
      const deleteIds = existingRows.slice(0, deleteCount).map((item) => item.id);
      await client.query(
        'DELETE FROM public.resume WHERE user_id = $1 AND id = ANY($2::bigint[])',
        [userId, deleteIds],
      );
    }

    const payload = buildResumePayload(body);
    const { rows } = await client.query(
      `INSERT INTO public.resume (
        user_id, title, resume_json, template_id, score, client_request_id, create_time, update_time
      ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
      RETURNING *`,
      [userId, payload.title, payload.resume_json, payload.template_id, payload.score, clientRequestId],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { data: rows[0], error: null, idempotent: false };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    return { data: null, error };
  } finally {
    client.release();
  }
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

async function createHistory(userId, resumeId, body, sourceType) {
  const payload = {
    resume_id: resumeId,
    user_id: userId,
    ...buildResumePayload(body),
    // 历史类型只记录 AI 生成/优化来源，便于前端展示而不参与权限判断。
    source_type: sourceType || 'ai_optimize',
    create_time: new Date().toISOString(),
  };
  return dbAdmin.from('resume_history').insert(payload).select().single();
}

async function trimHistory(resumeId, keepCount) {
  const { data, error } = await dbAdmin
    .from('resume_history')
    .select('id')
    .eq('resume_id', resumeId)
    .order('create_time', { ascending: false })
    .order('id', { ascending: false });
  if (error) return { data: null, error };
  const deleteIds = (data || []).slice(Number(keepCount)).map((item) => item.id);
  if (!deleteIds.length) return { data: [], error: null };
  return dbAdmin.from('resume_history').delete().in('id', deleteIds);
}

async function listHistory(userId, resumeId) {
  return dbAdmin
    .from('resume_history')
    .select('*')
    .eq('user_id', userId)
    .eq('resume_id', resumeId)
    .order('create_time', { ascending: false })
    .order('id', { ascending: false });
}

async function findHistoryById(userId, resumeId, historyId) {
  return dbAdmin
    .from('resume_history')
    .select('*')
    .eq('id', historyId)
    .eq('user_id', userId)
    .eq('resume_id', resumeId)
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

async function listAdmin({ from, to, userId, userIds, keyword }) {
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
  // 简历标题筛选与精确用户筛选、管理员归属范围同时生效。
  if (keyword) query = query.ilike('title', `%${keyword}%`)
  return query
}

module.exports = {
  createResume,
  createWithinLimit,
  updateResume,
  findById,
  findByIdAdmin,
  listByUser,
  deleteResume,
  deleteMany,
  countByUser,
  findOldestByUser,
  listAdmin,
  createHistory,
  trimHistory,
  listHistory,
  findHistoryById,
};
