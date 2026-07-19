/**
 * 用户中心：任务模型与提示词配置
 */

const userAiConfigService = require('../services/user/userAiConfig.service')
const { handleError } = require('../utils/response')

async function listTaskModels(req, res) {
  try {
    const data = await userAiConfigService.listUserTaskModels(req.user.id)
    return res.json({ success: true, ...data })
  } catch (err) {
    return handleError(res, err)
  }
}

async function saveTaskModel(req, res) {
  try {
    const data = await userAiConfigService.upsertUserTaskModel(
      req.user.id,
      req.params.taskType,
      req.body.model_id,
    )
    return res.json({ success: true, data, message: '已保存' })
  } catch (err) {
    return handleError(res, err)
  }
}

async function clearTaskModel(req, res) {
  try {
    await userAiConfigService.deleteUserTaskModel(req.user.id, req.params.taskType)
    return res.json({ success: true, message: '已恢复管理员默认模型' })
  } catch (err) {
    return handleError(res, err)
  }
}

async function listTaskPrompts(req, res) {
  try {
    const data = await userAiConfigService.listUserTaskPrompts(req.user.id)
    return res.json({ success: true, ...data })
  } catch (err) {
    return handleError(res, err)
  }
}

async function saveTaskPrompt(req, res) {
  try {
    const data = await userAiConfigService.upsertUserTaskPrompt(
      req.user.id,
      req.params.taskType,
      req.body.instruction,
    )
    return res.json({ success: true, data, message: '已保存' })
  } catch (err) {
    return handleError(res, err)
  }
}

async function clearTaskPrompt(req, res) {
  try {
    await userAiConfigService.deleteUserTaskPrompt(req.user.id, req.params.taskType)
    return res.json({ success: true, message: '已恢复默认提示词' })
  } catch (err) {
    return handleError(res, err)
  }
}

module.exports = {
  listTaskModels,
  saveTaskModel,
  clearTaskModel,
  listTaskPrompts,
  saveTaskPrompt,
  clearTaskPrompt,
}
