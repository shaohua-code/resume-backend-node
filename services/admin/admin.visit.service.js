/**
 * 管理后台访客记录服务
 */

const visitService = require('../visit/visit.service')

async function listVisits(req, from, to) {
  return visitService.listVisitsForAdmin(req, from, to)
}

module.exports = { listVisits }
