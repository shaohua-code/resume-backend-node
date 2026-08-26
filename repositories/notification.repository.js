/**
 * 管理员收件箱数据仓库
 */

const { dbAdmin } = require('../dbClient')

const SOURCE_USER_FEEDBACK = 'USER_FEEDBACK'

async function insertNotification(payload) {
  return dbAdmin.from('admin_notification').insert(payload).select('id').single()
}

async function listByRecipient({ recipientAdminId, from, to }) {
  return dbAdmin
    .from('admin_notification')
    .select('*', { count: 'exact' })
    .eq('recipient_admin_id', recipientAdminId)
    .order('create_time', { ascending: false })
    .range(from, to)
}

async function countUnread(recipientAdminId) {
  return dbAdmin
    .from('admin_notification')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_admin_id', recipientAdminId)
    .is('read_at', null)
}

async function findByIdForRecipient(id, recipientAdminId) {
  return dbAdmin
    .from('admin_notification')
    .select('*')
    .eq('id', id)
    .eq('recipient_admin_id', recipientAdminId)
    .maybeSingle()
}

async function markRead(id, recipientAdminId, readAt) {
  return dbAdmin
    .from('admin_notification')
    .update({ read_at: readAt })
    .eq('id', id)
    .eq('recipient_admin_id', recipientAdminId)
    .is('read_at', null)
    .select('id, read_at')
    .maybeSingle()
}

async function markAllRead(recipientAdminId, readAt) {
  return dbAdmin
    .from('admin_notification')
    .update({ read_at: readAt })
    .eq('recipient_admin_id', recipientAdminId)
    .is('read_at', null)
    .select('id')
}

module.exports = {
  SOURCE_USER_FEEDBACK,
  insertNotification,
  listByRecipient,
  countUnread,
  findByIdForRecipient,
  markRead,
  markAllRead,
}
