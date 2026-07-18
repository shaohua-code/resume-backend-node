/**
 * 简历接口参数校验规则
 * 配合 express-validator 使用
 */

const { body, param, query } = require('express-validator')

/**
 * 创建简历参数校验
 */
const create = [
  body('title').optional().isString().withMessage('title 必须是字符串'),
  body('resume_json').notEmpty().withMessage('resume_json 不能为空'),
  // 客户端生成保存键，保证 AI 已完成但网络响应丢失时可安全重试。
  body('client_request_id').optional().isString().trim().isLength({ min: 8, max: 100 }).withMessage('client_request_id 长度必须为 8-100 个字符'),
]

/**
 * 更新简历参数校验
 */
const update = [
  param('id').notEmpty().withMessage('简历 id 不能为空'),
  body('title').optional().isString().withMessage('title 必须是字符串'),
  body('resume_json').optional().notEmpty().withMessage('resume_json 不能为空'),
]

/**
 * 保存简历参数校验
 */
const save = [
  body('title').optional().isString().withMessage('title 必须是字符串'),
  body('resume_json').notEmpty().withMessage('resume_json 不能为空'),
  body('client_request_id').optional().isString().trim().isLength({ min: 8, max: 100 }).withMessage('client_request_id 长度必须为 8-100 个字符'),
]

/**
 * 获取简历详情参数校验
 */
const detail = [
  query('resume_id').notEmpty().withMessage('resume_id 不能为空'),
]

/**
 * 删除简历参数校验
 */
const remove = [
  query('resume_id').optional().notEmpty().withMessage('resume_id 不能为空'),
  body('resume_id').optional().notEmpty().withMessage('resume_id 不能为空'),
]

/**
 * 批量删除简历参数校验
 */
const batchRemove = [
  body('ids').isArray({ min: 1 }).withMessage('ids 必须是非空数组'),
]

/**
 * 导出记录参数校验
 */
const recordExport = [
  query('resume_id').optional().notEmpty().withMessage('resume_id 不能为空'),
  body('resume_id').optional().notEmpty().withMessage('resume_id 不能为空'),
]

module.exports = {
  create,
  update,
  save,
  detail,
  remove,
  batchRemove,
  recordExport,
}
