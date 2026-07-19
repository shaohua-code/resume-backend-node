/**
 * 用户中心：账户资料、任务模型与提示词配置
 */

const userAiConfigService = require('../services/user/userAiConfig.service')
const userProfileService = require('../services/user/userProfile.service')
const { handleError } = require('../utils/response')

/** 获取当前登录用户资料 */
async function getProfile(req, res) {
  try {
    const data = await userProfileService.getMyProfile(req.user.id)
    return res.json({ success: true, data })
  } catch (err) {
    return handleError(res, err)
  }
}

/** 更新昵称等自助资料字段 */
async function updateProfile(req, res) {
  try {
    const data = await userProfileService.updateMyProfile(req.user.id, {
      nickname: req.body.nickname,
    })
    return res.json({ success: true, data, message: '资料已更新' })
  } catch (err) {
    return handleError(res, err)
  }
}

/** 旧密码改密，并返回新会话令牌 */
async function changePassword(req, res) {
  try {
    const result = await userProfileService.changeMyPassword(
      req.user.id,
      req.body.old_password,
      req.body.new_password,
    )
    const profile = result.profile
    const session = result.session
    return res.json({
      success: true,
      message: '密码已更新',
      data: profile,
      token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      account: profile.account,
      email: profile.email,
      email_verified: profile.email_verified,
      email_bound: profile.email_bound,
      nickname: profile.nickname,
      user_id: profile.user_id,
      role: profile.role,
      status: profile.status,
    })
  } catch (err) {
    return handleError(res, err)
  }
}

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
  getProfile,
  updateProfile,
  changePassword,
  listTaskModels,
  saveTaskModel,
  clearTaskModel,
  listTaskPrompts,
  saveTaskPrompt,
  clearTaskPrompt,
}
