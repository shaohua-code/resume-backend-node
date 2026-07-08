/**
 * 通用参数校验中间件
 * 配合 express-validator 使用，统一返回 400 错误
 */

const { validationResult } = require('express-validator');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ detail: errors.array()[0].msg });
  }
  next();
}

module.exports = { validate };
