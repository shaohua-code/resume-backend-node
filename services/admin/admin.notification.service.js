/**
 * 管理端收件箱：用户反馈等事件按接收人落库，查询只返回当前管理员自己的消息
 */

const notificationRepo = require('../../repositories/notification.repository')
const {
  attachUserProfiles,
  findOwningAdminId,
  listSuperAdminIds,
} = require('./admin.common.service')

function stripSummary(text) {
  const summary = String(text || '').replace(/\s+/g, ' ').trim()
  if (!summary) return '用户提交了一条反馈'
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary
}

/**
 * 用户反馈成功后写入收件箱
 * 归属 ADMIN 与每位 SUPER_ADMIN 各一条，唯一约束避免重复
 */
async function createFeedbackNotifications({ feedbackId, userId, summary }) {
  const recipients = new Set()
  const owningAdminId = await findOwningAdminId(userId)
  if (owningAdminId) recipients.add(owningAdminId)
  const superAdminIds = await listSuperAdminIds()
  superAdminIds.forEach((id) => recipients.add(id))

  const payloadBase = {
    source_type: notificationRepo.SOURCE_USER_FEEDBACK,
    source_id: Number(feedbackId),
    actor_user_id: userId || null,
    title: '用户反馈',
    summary: stripSummary(summary),
    create_time: new Date().toISOString(),
  }

  await Promise.all([...recipients].map(async (recipientAdminId) => {
    const { error } = await notificationRepo.insertNotification({
      ...payloadBase,
      recipient_admin_id: recipientAdminId,
    })
    // 23505：同一接收人重复事件，忽略即可
    if (error && error.code !== '23505') {
      throw Object.assign(new Error(`写入消息失败：${error.message}`), { statusCode: 500 })
    }
  }))
}

async function listNotifications(req, from, to) {
  const { data, error, count } = await notificationRepo.listByRecipient({
    recipientAdminId: req.user.id,
    from,
    to,
  })
  if (error) {
    throw Object.assign(new Error(`查询消息失败：${error.message}`), { statusCode: 500 })
  }
  const items = await attachUserProfiles(data || [], 'actor_user_id')
  return {
    items,
    total: count || 0,
    page: Number(req.query.page || '1'),
    size: Number(req.query.size || '20'),
  }
}

async function getUnreadCount(req) {
  const { error, count } = await notificationRepo.countUnread(req.user.id)
  if (error) {
    throw Object.assign(new Error(`查询未读数失败：${error.message}`), { statusCode: 500 })
  }
  return { unread_count: count || 0 }
}

async function markNotificationRead(req) {
  const { data, error } = await notificationRepo.markRead(
    req.params.id,
    req.user.id,
    new Date().toISOString(),
  )
  if (error) {
    throw Object.assign(new Error(`标记已读失败：${error.message}`), { statusCode: 500 })
  }
  if (!data) {
    const existing = await notificationRepo.findByIdForRecipient(req.params.id, req.user.id)
    if (!existing.data) {
      throw Object.assign(new Error('消息不存在'), { statusCode: 404 })
    }
    return existing.data
  }
  return data
}

async function markAllNotificationsRead(req) {
  const { error } = await notificationRepo.markAllRead(req.user.id, new Date().toISOString())
  if (error) {
    throw Object.assign(new Error(`全部已读失败：${error.message}`), { statusCode: 500 })
  }
  return { success: true }
}

module.exports = {
  createFeedbackNotifications,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
}
