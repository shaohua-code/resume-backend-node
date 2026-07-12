/**
 * 管理员充值二维码服务
 * 按 admin_id 隔离配置；用户侧通过归属关系解析对应管理员的二维码
 */

const { dbAdmin } = require('../../dbClient')
const { ROLES } = require('../../utils/permissions')

/**
 * 获取指定管理员的充值配置
 * @param {string} adminId
 */
async function getOwnConfig(adminId) {
  const { data, error } = await dbAdmin
    .from('admin_recharge_config')
    .select('*')
    .eq('admin_id', adminId)
    .maybeSingle()

  if (error) {
    throw Object.assign(new Error(`查询充值配置失败：${error.message}`), { statusCode: 500 })
  }

  return data || {
    admin_id: adminId,
    payment_qrcode_url: '',
    contact_qrcode_url: '',
    payment_platform: '',
    contact_platform: '',
    update_time: null,
  }
}

/**
 * 保存当前管理员的充值配置（upsert，仅影响自己）
 * @param {string} adminId
 * @param {{ payment_qrcode_url?: string, contact_qrcode_url?: string, payment_platform?: string, contact_platform?: string }} payload
 */
async function upsertOwnConfig(adminId, payload) {
  const current = await getOwnConfig(adminId)
  const row = {
    admin_id: adminId,
    payment_qrcode_url: payload.payment_qrcode_url ?? current.payment_qrcode_url ?? '',
    contact_qrcode_url: payload.contact_qrcode_url ?? current.contact_qrcode_url ?? '',
    payment_platform: payload.payment_platform ?? current.payment_platform ?? '',
    contact_platform: payload.contact_platform ?? current.contact_platform ?? '',
    update_time: new Date().toISOString(),
  }

  const { data, error } = await dbAdmin
    .from('admin_recharge_config')
    .upsert(row, { onConflict: 'admin_id' })
    .select('*')
    .single()

  if (error) {
    throw Object.assign(new Error(`保存充值配置失败：${error.message}`), { statusCode: 500 })
  }

  return data
}

/**
 * 解析用户应展示的管理员 ID
 * 优先归属管理员，无归属则回退首个 SUPER_ADMIN
 * @param {string} userId
 */
async function resolveAdminIdForUser(userId) {
  const { data: relation, error: relationError } = await dbAdmin
    .from('admin_user_relation')
    .select('admin_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (relationError) {
    throw Object.assign(new Error(`查询用户归属失败：${relationError.message}`), { statusCode: 500 })
  }

  if (relation?.admin_id) {
    return relation.admin_id
  }

  const { data: superAdmins, error: superError } = await dbAdmin
    .from('user_profile')
    .select('user_id')
    .eq('role', ROLES.SUPER_ADMIN)
    .order('create_time', { ascending: true })
    .limit(1)

  if (superError) {
    throw Object.assign(new Error(`查询超级管理员失败：${superError.message}`), { statusCode: 500 })
  }

  return superAdmins?.[0]?.user_id || null
}

/**
 * 获取用户充值弹窗所需的二维码信息
 * @param {string} userId
 */
async function resolveRechargeInfoForUser(userId) {
  const adminId = await resolveAdminIdForUser(userId)

  if (!adminId) {
    return {
      payment_qrcode_url: '',
      contact_qrcode_url: '',
      payment_platform: '',
      contact_platform: '',
      admin_nickname: '',
    }
  }

  const config = await getOwnConfig(adminId)

  const { data: profile } = await dbAdmin
    .from('user_profile')
    .select('nickname')
    .eq('user_id', adminId)
    .maybeSingle()

  return {
    payment_qrcode_url: config.payment_qrcode_url || '',
    contact_qrcode_url: config.contact_qrcode_url || '',
    payment_platform: config.payment_platform || '',
    contact_platform: config.contact_platform || '',
    admin_nickname: profile?.nickname || '',
  }
}

module.exports = {
  getOwnConfig,
  upsertOwnConfig,
  resolveAdminIdForUser,
  resolveRechargeInfoForUser,
}
