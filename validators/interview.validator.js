/** 面试题列表与练习接口只接受明确的分页、状态和长度范围。 */
const { body, param, query } = require('express-validator')

const userList = [
  query('page').optional().isInt({ min: 1 }).withMessage('页码无效'),
  query('size').optional().isInt({ min: 1, max: 100 }).withMessage('每页条数无效'),
  query('resume_id').optional().isInt({ min: 1 }).withMessage('简历筛选条件无效'),
  query('status').optional().isIn(['todo', 'practicing', 'mastered']).withMessage('练习状态无效'),
  query('keyword').optional().isString().isLength({ max: 120 }).withMessage('搜索内容过长'),
]

const setId = [param('setId').isInt({ min: 1 }).withMessage('套题编号无效')]
// 队列与点评子资源的路径参数均为正整数，后端仍会再校验当前账号归属。
const jobId = [param('jobId').isInt({ min: 1 }).withMessage('生成任务编号无效')]
const jobList = [query('limit').optional().isInt({ min: 1, max: 20 }).withMessage('任务条数无效')]
const practice = [
  ...setId,
  param('questionId').isInt({ min: 1 }).withMessage('题目编号无效'),
  body('status').isIn(['todo', 'practiced', 'mastered']).withMessage('练习状态无效'),
  body('answer_draft').optional().isString().isLength({ max: 20000 }).withMessage('回答草稿最多 20000 个字符'),
  body('reflection').optional().isString().isLength({ max: 8000 }).withMessage('复盘内容最多 8000 个字符'),
]

const adminList = [
  query('page').optional().isInt({ min: 1 }).withMessage('页码无效'),
  query('size').optional().isInt({ min: 1, max: 100 }).withMessage('每页条数无效'),
  query('user_id').optional().isUUID().withMessage('用户编号无效'),
  query('keyword').optional().isString().isLength({ max: 120 }).withMessage('岗位搜索内容过长'),
  query('user_keyword').optional().isString().isLength({ max: 120 }).withMessage('用户搜索内容过长'),
  query('status').optional().isIn(['todo', 'practicing', 'mastered']).withMessage('练习状态无效'),
]

// AI 点评只允许提交当前答案草稿；岗位和简历证据必须从本人题库快照读取。
const answerReview = [
  ...setId,
  param('questionId').isInt({ min: 1 }).withMessage('题目编号无效'),
  body('answer_draft').isString().trim().isLength({ min: 1, max: 20000 }).withMessage('请填写回答，最多 20000 个字符'),
]
const reviewList = [
  ...setId,
  param('questionId').isInt({ min: 1 }).withMessage('题目编号无效'),
]

module.exports = { userList, setId, jobId, jobList, practice, answerReview, reviewList, adminList }
