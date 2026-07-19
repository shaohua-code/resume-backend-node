/**
 * 用户侧版本公告：仅返回当前时间窗内已启用的公告，供首次进入弹窗。
 */

const { dbAdmin } = require('../../dbClient')

/**
 * 规范化公告写入字段，并校验时间窗。
 * @param {Object} body
 * @returns {Object}
 */
function sanitizeAnnouncementBody(body = {}) {
  const title = String(body.title || '').trim()
  const content = String(body.content || '').trim()
  if (!title) {
    throw Object.assign(new Error('请填写公告标题'), { statusCode: 400 })
  }
  if (!content) {
    throw Object.assign(new Error('请填写公告内容'), { statusCode: 400 })
  }

  const startAt = body.start_at ? new Date(body.start_at) : null
  const endAt = body.end_at ? new Date(body.end_at) : null
  if (startAt && Number.isNaN(startAt.getTime())) {
    throw Object.assign(new Error('开始时间格式无效'), { statusCode: 400 })
  }
  if (endAt && Number.isNaN(endAt.getTime())) {
    throw Object.assign(new Error('结束时间格式无效'), { statusCode: 400 })
  }
  if (startAt && endAt && startAt.getTime() > endAt.getTime()) {
    throw Object.assign(new Error('开始时间不能晚于结束时间'), { statusCode: 400 })
  }

  return {
    title,
    content,
    version_label: String(body.version_label || '').trim(),
    start_at: startAt ? startAt.toISOString() : null,
    end_at: endAt ? endAt.toISOString() : null,
    enabled: body.enabled !== false,
  }
}

/**
 * 列出对当前用户可见的生效公告（按创建时间倒序）。
 */
async function listActiveAnnouncements() {
  const now = new Date().toISOString()
  const { data, error } = await dbAdmin
    .from('announcement')
    .select('id,title,content,version_label,start_at,end_at,create_time')
    .eq('enabled', true)
    .order('create_time', { ascending: false })

  if (error) {
    throw Object.assign(new Error(`查询公告失败：${error.message}`), { statusCode: 500 })
  }

  const nowMs = Date.parse(now)
  return (data || []).filter((item) => {
    if (item.start_at && Date.parse(item.start_at) > nowMs) return false
    if (item.end_at && Date.parse(item.end_at) < nowMs) return false
    return true
  })
}

module.exports = {
  sanitizeAnnouncementBody,
  listActiveAnnouncements,
}
