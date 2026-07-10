/**
 * 管理后台邀请链接服务
 * 管理员生成邀请链接，用户通过链接注册时绑定归属关系
 */

const { supabaseAdmin } = require('../../supabaseClient')
const crypto = require('crypto')

/**
 * 生成唯一邀请码（16 位）
 * @returns {string}
 */
function generateInviteCode() {
  return crypto.randomBytes(8).toString('hex')
}

/**
 * 查询当前管理员的邀请链接列表
 * @param {Object} req
 * @returns {Promise<Object>} 邀请链接列表
 */
async function listInviteLinks(req) {
  const { data, error } = await supabaseAdmin
    .from('invite_link')
    .select('*')
    .eq('admin_id', req.user.id)
    .order('create_time', { ascending: false })

  if (error) {
    throw Object.assign(new Error(`查询邀请链接失败：${error.message}`), { statusCode: 500 })
  }

  return { items: data || [] }
}

/**
 * 创建邀请链接
 * @param {Object} req
 * @returns {Promise<Object>} 新建的邀请链接
 */
async function createInviteLink(req) {
  const expireTime = req.body.expire_time || null
  const code = generateInviteCode()
  const now = new Date().toISOString()

  const { data, error } = await supabaseAdmin
    .from('invite_link')
    .insert({
      admin_id: req.user.id,
      code,
      status: 'ACTIVE',
      expire_time: expireTime,
      used_count: 0,
      create_time: now,
    })
    .select()
    .single()

  if (error) {
    throw Object.assign(new Error(`创建邀请链接失败：${error.message}`), { statusCode: 500 })
  }

  return data
}

/**
 * 更新邀请链接状态（启用/禁用）
 * @param {Object} req
 * @returns {Promise<Object>} 更新后的邀请链接
 */
async function updateInviteLink(req) {
  const { id } = req.params
  const payload = {}
  if (req.body.status) payload.status = req.body.status
  if (req.body.expire_time !== undefined) payload.expire_time = req.body.expire_time

  if (Object.keys(payload).length === 0) {
    throw Object.assign(new Error('无更新字段'), { statusCode: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('invite_link')
    .update(payload)
    .eq('id', id)
    .eq('admin_id', req.user.id)
    .select()
    .maybeSingle()

  if (error) {
    throw Object.assign(new Error(`更新邀请链接失败：${error.message}`), { statusCode: 500 })
  }
  if (!data) {
    throw Object.assign(new Error('邀请链接不存在或无权操作'), { statusCode: 404 })
  }

  return data
}

/**
 * 删除邀请链接
 * @param {Object} req
 */
async function deleteInviteLink(req) {
  const { id } = req.params
  const { error } = await supabaseAdmin
    .from('invite_link')
    .delete()
    .eq('id', id)
    .eq('admin_id', req.user.id)

  if (error) {
    throw Object.assign(new Error(`删除邀请链接失败：${error.message}`), { statusCode: 500 })
  }
}

/**
 * 校验邀请码并返回邀请人 ID
 * 用于注册流程：校验邀请码有效，返回 admin_id 用于绑定归属
 * @param {string} code
 * @returns {Promise<string|null>} 邀请人 admin_id；无效返回 null
 */
async function validateInviteCode(code) {
  if (!code) return null

  const { data, error } = await supabaseAdmin
    .from('invite_link')
    .select('admin_id, status, expire_time')
    .eq('code', code)
    .maybeSingle()

  if (error || !data) return null
  if (data.status !== 'ACTIVE') return null

  // 校验过期时间
  if (data.expire_time && new Date(data.expire_time) < new Date()) {
    return null
  }

  return data.admin_id
}

/**
 * 邀请码使用次数 +1
 * @param {string} code
 */
async function incrementUsedCount(code) {
  if (!code) return
  const { data: link } = await supabaseAdmin
    .from('invite_link')
    .select('used_count')
    .eq('code', code)
    .maybeSingle()

  if (!link) return

  await supabaseAdmin
    .from('invite_link')
    .update({ used_count: (link.used_count || 0) + 1 })
    .eq('code', code)
}

/**
 * 注册成功后绑定用户归属关系
 * @param {string} userId - 新注册用户 ID
 * @param {string} adminId - 邀请人管理员 ID
 */
async function bindUserRelation(userId, adminId) {
  const now = new Date().toISOString()
  const { error } = await supabaseAdmin.from('admin_user_relation').insert({
    admin_id: adminId,
    user_id: userId,
    bind_type: 'INVITE_LINK',
    create_time: now,
  })

  if (error) {
    // 已存在归属关系时忽略
    if (error.code === '23505') return
    throw Object.assign(new Error(`绑定归属关系失败：${error.message}`), { statusCode: 500 })
  }
}

module.exports = {
  listInviteLinks,
  createInviteLink,
  updateInviteLink,
  deleteInviteLink,
  validateInviteCode,
  incrementUsedCount,
  bindUserRelation,
}
