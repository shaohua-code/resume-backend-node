/**
 * 钱包控制器
 * 处理用户侧余额与流水查询
 */

const walletService = require('../services/wallet/wallet.service')

/**
 * 解析分页参数
 * @param {Object} req
 */
function parsePagination(req) {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1)
  const size = Math.min(Math.max(parseInt(req.query.size || '10', 10), 1), 100)
  return { page, size }
}

function handleError(res, err) {
  return res.status(err.statusCode || 500).json({ detail: err.message, code: err.code })
}

/**
 * 获取当前用户余额
 */
async function getBalance(req, res) {
  try {
    const data = await walletService.getBalance(req.user.id, req.user.role)
    return res.json({ success: true, data })
  } catch (err) {
    return handleError(res, err)
  }
}

/**
 * 获取当前用户流水
 */
async function listLedger(req, res) {
  try {
    const { page, size } = parsePagination(req)
    const result = await walletService.listLedger(req.user.id, page, size)
    return res.json({ success: true, total: result.total, items: result.items })
  } catch (err) {
    return handleError(res, err)
  }
}

module.exports = {
  getBalance,
  listLedger,
}
