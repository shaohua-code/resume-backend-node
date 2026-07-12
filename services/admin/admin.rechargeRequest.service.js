/**
 * 充值凭证申请与审核服务
 * 用户提交凭证 → 管理员审核入账 → 邮件通知
 */

const { dbAdmin } = require('../../dbClient')
const { settings } = require('../../config')
const { ROLES } = require('../../utils/permissions')
const userRepo = require('../../repositories/user.repository')
const { sendTemplateEmail } = require('../../lib/email')
const {
  BRAND,
  buildRechargeAdminNotifyHtml,
  buildRechargeUserConfirmHtml,
  renderTemplate,
  resolveAbsoluteUrl,
} = require('../../lib/emailTemplates')
const { transferBalance } = require('../wallet/wallet.service')
const { logAdminAction, attachUserProfiles } = require('./admin.common.service')
const {
  resolveAdminIdForUser,
  resolveRechargeInfoForUser,
} = require('./admin.recharge.service')

const TEMPLATE_KEYS = {
  ADMIN_NOTIFY: 'recharge_email_admin_notify',
  USER_CONFIRM: 'recharge_email_user_confirm',
}

/** 格式化金额，保留 2 位展示 */
function formatMoney(value) {
  return Number(value || 0).toFixed(2)
}

/** 格式化时间为本地可读字符串 */
function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 校验当前管理员是否有权操作该充值记录
 * @param {Object} req
 * @param {Object} record
 */
function assertCanAccessRequest(req, record) {
  if (req.user.role === ROLES.SUPER_ADMIN) return
  if (record.admin_id !== req.user.id) {
    throw Object.assign(new Error('无权操作该充值记录'), { statusCode: 403 })
  }
}

/**
 * 读取邮件模板配置
 * @param {string} configKey
 */
async function loadEmailTemplateConfig(configKey) {
  const { data, error } = await dbAdmin
    .from('system_config')
    .select('config_value')
    .eq('config_key', configKey)
    .maybeSingle()

  if (error) {
    throw Object.assign(new Error(`读取邮件模板失败：${error.message}`), { statusCode: 500 })
  }

  return data?.config_value || {}
}

/**
 * 构建邮件渲染变量
 * @param {Object} record
 * @param {Object} userProfile
 * @param {Object} adminProfile
 */
function buildEmailVars(record, userProfile, adminProfile) {
  const proofImageUrl = resolveAbsoluteUrl(settings.PUBLIC_APP_URL, record.proof_url || '')
  return {
    user_nickname: userProfile?.nickname || userProfile?.email || '用户',
    user_email: userProfile?.email || '',
    paid_amount: formatMoney(record.paid_amount),
    grant_amount: formatMoney(record.grant_amount ?? record.paid_amount),
    proof_image_url: proofImageUrl,
    admin_nickname: adminProfile?.nickname || adminProfile?.email || '管理员',
    create_time: formatDateTime(record.create_time),
  }
}

/**
 * 渲染指定类型的充值邮件
 * @param {string} type admin_notify | user_confirm
 * @param {Object} record
 * @param {Object} userProfile
 * @param {Object} adminProfile
 */
async function renderRechargeEmail(type, record, userProfile, adminProfile) {
  const configKey = type === 'user_confirm' ? TEMPLATE_KEYS.USER_CONFIRM : TEMPLATE_KEYS.ADMIN_NOTIFY
  const templateConfig = await loadEmailTemplateConfig(configKey)
  const vars = buildEmailVars(record, userProfile, adminProfile)

  const defaultHtml = type === 'user_confirm'
    ? buildRechargeUserConfirmHtml(vars)
    : buildRechargeAdminNotifyHtml(vars)

  const htmlTemplate = templateConfig.html || defaultHtml
  const html = renderTemplate(htmlTemplate, vars)
  const defaultSubject = type === 'user_confirm' ? '充值已到账' : '用户提交了充值凭证'
  const subject = renderTemplate(templateConfig.subject || `【${BRAND}】${defaultSubject}`, vars)
  const text = renderTemplate(
    templateConfig.text || `${subject}\n用户：${vars.user_nickname}\n实付：¥${vars.paid_amount}`,
    vars,
  )

  return { subject, text, html }
}

/**
 * 用户提交充值凭证
 * @param {string} userId
 * @param {{ proof_url: string, paid_amount: number }} payload
 */
async function submitRequest(userId, payload) {
  const proofUrl = String(payload.proof_url || '').trim()
  const paidAmount = Number(payload.paid_amount)

  if (!proofUrl) {
    throw Object.assign(new Error('请上传支付凭证'), { statusCode: 400 })
  }
  if (!paidAmount || Number.isNaN(paidAmount) || paidAmount <= 0) {
    throw Object.assign(new Error('实付金额必须大于 0'), { statusCode: 400 })
  }

  const adminId = await resolveAdminIdForUser(userId)
  if (!adminId) {
    throw Object.assign(new Error('未找到归属管理员，请联系客服'), { statusCode: 400 })
  }

  const now = new Date().toISOString()
  const { data: record, error } = await dbAdmin
    .from('recharge_request')
    .insert({
      user_id: userId,
      admin_id: adminId,
      proof_url: proofUrl,
      paid_amount: paidAmount,
      status: 'PENDING',
      create_time: now,
      update_time: now,
    })
    .select('*')
    .single()

  if (error) {
    throw Object.assign(new Error(`提交充值凭证失败：${error.message}`), { statusCode: 500 })
  }

  // 异步发送管理员通知邮件（失败不阻断提交）
  try {
    const [{ data: userProfile }, { data: adminProfile }] = await Promise.all([
      dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', userId).maybeSingle(),
      dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', adminId).maybeSingle(),
    ])
    const emailContent = await renderRechargeEmail('admin_notify', record, userProfile, adminProfile)
    if (adminProfile?.email) {
      await sendTemplateEmail(adminProfile.email, emailContent.subject, emailContent.text, emailContent.html)
    }
  } catch (mailErr) {
    console.warn('[rechargeRequest] 发送管理员通知邮件失败：', mailErr.message)
  }

  const contactInfo = await resolveRechargeInfoForUser(userId)
  return {
    request_id: record.id,
    ...contactInfo,
  }
}

/**
 * 管理端分页查询充值记录
 * @param {Object} req
 * @param {number} from
 * @param {number} to
 */
async function listRequests(req, from, to) {
  let query = dbAdmin
    .from('recharge_request')
    .select('*', { count: 'exact' })
    .order('create_time', { ascending: false })
    .range(from, to)

  if (req.user.role !== ROLES.SUPER_ADMIN) {
    query = query.eq('admin_id', req.user.id)
  }

  const { data, error, count } = await query
  if (error) {
    throw Object.assign(new Error(`查询充值记录失败：${error.message}`), { statusCode: 500 })
  }

  const itemsWithUser = await attachUserProfiles(data || [], 'user_id', 'user')
  // 超管查看全部记录时附加归属管理员账号信息
  const items = req.user.role === ROLES.SUPER_ADMIN
    ? await attachUserProfiles(itemsWithUser, 'admin_id', 'admin')
    : itemsWithUser
  return {
    total: count || 0,
    items: items.map((row) => ({
      ...row,
      paid_amount: Number(row.paid_amount || 0),
      grant_amount: row.grant_amount == null ? null : Number(row.grant_amount),
      create_time: String(row.create_time),
      update_time: String(row.update_time),
    })),
  }
}

/**
 * 获取单条充值记录详情
 * @param {Object} req
 * @param {number|string} id
 */
async function getRequestDetail(req, id) {
  const { data: record, error } = await dbAdmin
    .from('recharge_request')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw Object.assign(new Error(`查询充值记录失败：${error.message}`), { statusCode: 500 })
  }
  if (!record) {
    throw Object.assign(new Error('充值记录不存在'), { statusCode: 404 })
  }

  assertCanAccessRequest(req, record)

  const [{ data: userProfile }, { data: adminProfile }] = await Promise.all([
    dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', record.user_id).maybeSingle(),
    dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', record.admin_id).maybeSingle(),
  ])

  return {
    ...record,
    paid_amount: Number(record.paid_amount || 0),
    grant_amount: record.grant_amount == null ? null : Number(record.grant_amount),
    user: userProfile || null,
    admin: adminProfile || null,
  }
}

/**
 * 预览充值邮件 HTML
 * @param {Object} req
 * @param {number|string} id
 * @param {string} type admin_notify | user_confirm
 */
async function previewEmail(req, id, type) {
  const detail = await getRequestDetail(req, id)
  // 支持 query grant_amount 覆盖预览中的实际充值金额，便于审核弹窗实时联动
  const overrideGrant = Number(req.query?.grant_amount)
  const previewRecord = {
    ...detail,
    grant_amount: overrideGrant > 0
      ? overrideGrant
      : (detail.grant_amount ?? detail.paid_amount),
  }
  const emailContent = await renderRechargeEmail(
    type === 'user_confirm' ? 'user_confirm' : 'admin_notify',
    previewRecord,
    detail.user,
    detail.admin,
  )
  return {
    subject: emailContent.subject,
    html: emailContent.html,
  }
}

/**
 * 删除待充值记录（仅超管 + 仅 PENDING）
 * @param {Object} req
 * @param {number|string} id
 */
async function deleteRequest(req, id) {
  // 仅超级管理员可删除充值记录
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    throw Object.assign(new Error('无权删除充值记录'), { statusCode: 403 })
  }

  const { data: record, error } = await dbAdmin
    .from('recharge_request')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw Object.assign(new Error(`查询充值记录失败：${error.message}`), { statusCode: 500 })
  }
  if (!record) {
    throw Object.assign(new Error('充值记录不存在'), { statusCode: 404 })
  }
  if (record.status !== 'PENDING') {
    throw Object.assign(new Error('仅可删除待充值记录'), { statusCode: 400 })
  }

  const { error: deleteError } = await dbAdmin
    .from('recharge_request')
    .delete()
    .eq('id', id)

  if (deleteError) {
    throw Object.assign(new Error(`删除充值记录失败：${deleteError.message}`), { statusCode: 500 })
  }

  await logAdminAction(req, 'delete_recharge_request', 'recharge_request', id)

  return { id: Number(id) }
}

/**
 * 审核入账
 * @param {Object} req
 * @param {number|string} id
 * @param {{ grant_amount: number }} payload
 */
async function approveRequest(req, id, payload) {
  const grantAmount = Number(payload.grant_amount)
  if (!grantAmount || Number.isNaN(grantAmount) || grantAmount <= 0) {
    throw Object.assign(new Error('实际充值金额必须大于 0'), { statusCode: 400 })
  }

  const { data: record, error } = await dbAdmin
    .from('recharge_request')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !record) {
    throw Object.assign(new Error('充值记录不存在'), { statusCode: 404 })
  }
  if (record.status !== 'PENDING') {
    throw Object.assign(new Error('该记录已处理，无法重复审核'), { statusCode: 400 })
  }

  assertCanAccessRequest(req, record)

  const { data: target } = await userRepo.findById(record.user_id)
  if (!target) {
    throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
  }

  const remark = `充值审核入账（申请 #${record.id}，实付 ¥${formatMoney(record.paid_amount)}）`
  const transferResult = await transferBalance(
    req.user,
    target,
    grantAmount,
    remark,
    Number(record.paid_amount || 0),
  )

  const now = new Date().toISOString()
  const { data: updated, error: updateError } = await dbAdmin
    .from('recharge_request')
    .update({
      status: 'APPROVED',
      grant_amount: grantAmount,
      operator_id: req.user.id,
      ledger_id: transferResult.ledger?.id || null,
      update_time: now,
    })
    .eq('id', id)
    .select('*')
    .single()

  if (updateError) {
    throw Object.assign(new Error(`更新充值记录失败：${updateError.message}`), { statusCode: 500 })
  }

  await logAdminAction(req, 'approve_recharge', 'recharge_request', id)

  // 发送用户确认邮件
  try {
    const [{ data: userProfile }, { data: adminProfile }] = await Promise.all([
      dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', record.user_id).maybeSingle(),
      dbAdmin.from('user_profile').select('user_id, nickname, email').eq('user_id', req.user.id).maybeSingle(),
    ])
    const emailContent = await renderRechargeEmail(
      'user_confirm',
      { ...updated, create_time: now },
      userProfile,
      adminProfile,
    )
    if (userProfile?.email) {
      await sendTemplateEmail(userProfile.email, emailContent.subject, emailContent.text, emailContent.html)
    }
  } catch (mailErr) {
    console.warn('[rechargeRequest] 发送用户确认邮件失败：', mailErr.message)
  }

  return {
    ...updated,
    paid_amount: Number(updated.paid_amount || 0),
    grant_amount: Number(updated.grant_amount || 0),
    balance: transferResult.balance,
  }
}

/**
 * 读取两种充值邮件模板（仅超管）
 */
async function getEmailTemplates() {
  const [adminNotify, userConfirm] = await Promise.all([
    loadEmailTemplateConfig(TEMPLATE_KEYS.ADMIN_NOTIFY),
    loadEmailTemplateConfig(TEMPLATE_KEYS.USER_CONFIRM),
  ])

  return {
    admin_notify: {
      subject: adminNotify.subject || `【${BRAND}】用户提交了充值凭证`,
      html: adminNotify.html || buildRechargeAdminNotifyHtml(),
      text: adminNotify.text || '',
    },
    user_confirm: {
      subject: userConfirm.subject || `【${BRAND}】充值已到账`,
      html: userConfirm.html || buildRechargeUserConfirmHtml(),
      text: userConfirm.text || '',
    },
    placeholders: [
      '{{user_nickname}}',
      '{{user_email}}',
      '{{paid_amount}}',
      '{{grant_amount}}',
      '{{proof_image_url}}',
      '{{admin_nickname}}',
      '{{create_time}}',
    ],
  }
}

/**
 * 更新充值邮件模板（仅超管）
 * @param {Object} payload
 */
async function updateEmailTemplates(payload) {
  const now = new Date().toISOString()
  const entries = [
    { key: TEMPLATE_KEYS.ADMIN_NOTIFY, value: payload.admin_notify },
    { key: TEMPLATE_KEYS.USER_CONFIRM, value: payload.user_confirm },
  ]

  for (const entry of entries) {
    if (!entry.value) continue
    const { error } = await dbAdmin
      .from('system_config')
      .upsert({
        config_key: entry.key,
        config_value: {
          subject: String(entry.value.subject || '').trim(),
          html: String(entry.value.html || ''),
          text: String(entry.value.text || ''),
        },
        update_time: now,
      }, { onConflict: 'config_key' })

    if (error) {
      throw Object.assign(new Error(`保存邮件模板失败：${error.message}`), { statusCode: 500 })
    }
  }

  return getEmailTemplates()
}

module.exports = {
  submitRequest,
  listRequests,
  getRequestDetail,
  previewEmail,
  deleteRequest,
  approveRequest,
  getEmailTemplates,
  updateEmailTemplates,
}
