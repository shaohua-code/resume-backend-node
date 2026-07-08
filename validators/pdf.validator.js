/**
 * PDF 接口参数校验规则
 * 配合 express-validator 使用
 */

const { body } = require('express-validator')

/**
 * PDF 同步优化参数校验
 * 文件字段由 multer 处理，这里仅校验 target_position
 */
const uploadOptimize = [
  body('target_position').optional().isString().withMessage('target_position 必须是字符串'),
]

/**
 * 已有 PDF 优化参数校验
 */
const existingOptimize = [
  body('target_position').optional().isString().withMessage('target_position 必须是字符串'),
]

module.exports = {
  uploadOptimize,
  existingOptimize,
}
