/**
 * 简历数据仓库
 * 封装所有与 PostgreSQL resume 表直接交互的操作
 */

const { dbAdmin } = require('../dbClient');
const db = require('../lib/db');

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
        return { data: idempotentRows[0], error: null };
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
    return { data: rows[0], error: null };
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
};
