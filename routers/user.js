/**
 * 登录用户配置路由（资料 / 模型选择 / 提示词指令）
 */

const express = require('express')
const { authRequired, emailBindingRequired } = require('../middlewares/auth')
const { validate } = require('../middlewares/validate')
const userController = require('../controllers/user.controller')
const interviewController = require('../controllers/interview.controller')
const interviewValidator = require('../validators/interview.validator')

const router = express.Router()

router.use(authRequired)

router.get('/profile', userController.getProfile)
router.patch('/profile', userController.updateProfile)
router.post('/password', userController.changePassword)

router.get('/career-goals', userController.listCareerGoals)
router.post('/career-goals', userController.createCareerGoal)
router.patch('/career-goals/:goalId', userController.updateCareerGoal)
router.delete('/career-goals/:goalId', userController.deleteCareerGoal)

// 用户题库路由由认证身份限定归属，子资源更新同时校验套题和题目关系。
router.get('/interview-question-sets', interviewValidator.userList, validate, interviewController.listMySets)
router.get('/interview-question-sets/:setId', interviewValidator.setId, validate, interviewController.getMySet)
router.patch('/interview-question-sets/:setId/questions/:questionId/practice', interviewValidator.practice, validate, interviewController.updatePractice)
router.delete('/interview-question-sets/:setId', interviewValidator.setId, validate, interviewController.deleteMySet)
// 任务读取无需邮箱门禁，保证未绑定邮箱的用户也能恢复查看已入队状态。
router.get('/interview-question-jobs/active', interviewController.getActiveGenerationJob)
router.get('/interview-question-jobs', interviewValidator.jobList, validate, interviewController.listMyGenerationJobs)
router.get('/interview-question-jobs/:jobId', interviewValidator.jobId, validate, interviewController.getMyGenerationJob)
// 点评会触发独立 AI 调用，因此沿用邮箱绑定门禁。
router.post('/interview-question-sets/:setId/questions/:questionId/reviews', emailBindingRequired, interviewValidator.answerReview, validate, interviewController.createAnswerReview)
router.get('/interview-question-sets/:setId/questions/:questionId/reviews', interviewValidator.reviewList, validate, interviewController.listAnswerReviews)

router.get('/task-models', userController.listTaskModels)
router.put('/task-models/:taskType', userController.saveTaskModel)
router.delete('/task-models/:taskType', userController.clearTaskModel)

router.get('/task-prompts', userController.listTaskPrompts)
router.put('/task-prompts/:taskType', userController.saveTaskPrompt)
router.delete('/task-prompts/:taskType', userController.clearTaskPrompt)

module.exports = router
