const workspaceService = require('../services/workspace/workspace.service')
const { handleError } = require('../utils/response')

async function getSummary(req, res) {
  try { return res.json({ success: true, data: await workspaceService.getSummary(req.user.id) }) }
  catch (error) { return handleError(res, error) }
}

async function getOnboarding(req, res) {
  try { return res.json({ success: true, data: await workspaceService.getOnboarding(req.user.id) }) }
  catch (error) { return handleError(res, error) }
}

async function updateOnboarding(req, res) {
  try { return res.json({ success: true, data: await workspaceService.updateOnboarding(req.user.id, req.body || {}) }) }
  catch (error) { return handleError(res, error) }
}

module.exports = { getSummary, getOnboarding, updateOnboarding }
