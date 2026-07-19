/**
 * 登录用户配置路由（模型选择 / 提示词指令）
 */

const express = require('express')
const { authRequired } = require('../middlewares/auth')
const userController = require('../controllers/user.controller')

const router = express.Router()

router.use(authRequired)

router.get('/task-models', userController.listTaskModels)
router.put('/task-models/:taskType', userController.saveTaskModel)
router.delete('/task-models/:taskType', userController.clearTaskModel)

router.get('/task-prompts', userController.listTaskPrompts)
router.put('/task-prompts/:taskType', userController.saveTaskPrompt)
router.delete('/task-prompts/:taskType', userController.clearTaskPrompt)

module.exports = router
