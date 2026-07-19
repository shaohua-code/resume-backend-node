/**
 * 登录用户公告接口
 */

const announcementService = require('../services/announcement/announcement.service')
const { handleError } = require('../utils/response')

async function listActive(req, res) {
  try {
    const items = await announcementService.listActiveAnnouncements()
    return res.json({ success: true, items })
  } catch (err) {
    return handleError(res, err)
  }
}

module.exports = {
  listActive,
}
