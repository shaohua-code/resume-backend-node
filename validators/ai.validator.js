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
 * 纯文字识别接收原始简历文本。
 * 上限与 PDF 解析对齐，避免长简历后半段被接口拦掉。
 */
const extractResume = [
  body('raw_text')
    .isString()
    .withMessage('raw_text 必须是字符串')
    .bail()
    .trim()
    .isLength({ min: 20, max: 50000 })
    .withMessage('raw_text 长度必须在 20 到 50000 个字符之间'),
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
 * 岗位匹配分析参数校验
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

// 仅接受本人的资源编号、有限题量和稳定幂等键；模型配置不接受客户端指定。
const interviewQuestions = [
  body('resume_id').isInt({ min: 1 }).withMessage('请选择有效简历'),
  body('career_goal_id').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('求职目标无效'),
  body('saved_job_id').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('收藏岗位无效'),
  body('target_position').optional().isString().isLength({ max: 160 }).withMessage('目标岗位最多 160 个字符'),
  body('jd_text').optional().isString().isLength({ max: 12000 }).withMessage('岗位描述最多 12000 个字符'),
  body('question_count').optional().isIn([10, 20, 30, '10', '20', '30']).withMessage('题量仅支持 10、20 或 30 题'),
  body('categories').optional().isArray({ max: 5 }).withMessage('题目类型无效'),
  body('categories.*').optional().isIn(['professional', 'project', 'behavioral', 'gap', 'reverse']).withMessage('题目类型无效'),
  body('avoid_history').optional().isBoolean().withMessage('历史去重选项无效'),
  body('request_key').isUUID().withMessage('生成请求标识无效'),
]

module.exports = {
  generate,
  extractResume,
  optimizeStream,
  optimizeByJdStream,
  matchJd,
  score,
  interviewQuestions,
}
