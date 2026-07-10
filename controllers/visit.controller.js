/**
 * 访客记录控制器
 */

const visitService = require('../services/visit/visit.service')

function handleError(res, err) {
  return res.status(err.statusCode || 500).json({ detail: err.message })
}

async function createVisit(req, res) {
  try {
    const data = await visitService.createVisit(req)
    return res.json({ success: true, data })
  } catch (err) {
    return handleError(res, err)
  }
}

async function updateDuration(req, res) {
  try {
    const data = await visitService.updateVisitDuration(req.params.id, req.body?.duration_seconds)
    return res.json({ success: true, data })
  } catch (err) {
    return handleError(res, err)
  }
}

module.exports = { createVisit, updateDuration }
