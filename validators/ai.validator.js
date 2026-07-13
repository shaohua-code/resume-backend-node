/**
 * AI 接口参数校验规则
 * 配合 express-validator 使用
 */

const { body, param } = require('express-validator')

// 支持的优化类型：个人评价、技能特长、项目经历、实习经历、工作经历（正式全职）
const ALLOWED_OPTIMIZE_TYPES = ['summary', 'skills', 'project', 'internship', 'work_experience']

/**
 * AI 生成简历参数校验
 */
const generate = [
  body('target_position').optional().isString().withMessage('target_position 必须是字符串'),
]

/**
 * 分模块流式优化参数校验
 */
const optimizeStream = [
  param('type')
    .isIn(ALLOWED_OPTIMIZE_TYPES)
    .withMessage(`优化类型只能是：${ALLOWED_OPTIMIZE_TYPES.join('、')}`),
  body('resume').isObject().withMessage('resume 必须是对象'),
  body('resume.target_position')
    .notEmpty()
    .withMessage('请先填写意向岗位'),
  body('index')
    .optional()
    .isInt({ min: 0 })
    .withMessage('index 必须是非负整数'),
]

/**
 * JD 岗位描述流式优化简历参数校验
 */
const optimizeByJdStream = [
  body('resume').isObject().withMessage('resume 必须是对象'),
  body('jd_text').notEmpty().withMessage('jd_text 不能为空'),
]

/**
 * JD 匹配参数校验
 */
const matchJd = [
  body('resume_id').notEmpty().withMessage('resume_id 不能为空'),
  body('jd_text').notEmpty().withMessage('jd_text 不能为空'),
]

/**
 * 简历评分参数校验
 */
const score = [
  body('resume_id').optional().isString().withMessage('resume_id 必须是字符串'),
]

module.exports = {
  generate,
  optimizeStream,
  optimizeByJdStream,
  matchJd,
  score,
}
