/**
 * 管理后台消费记录服务
 * 普通管理员仅返回归属用户的流水；超级管理员返回所有
 */

const walletRepo = require('../../repositories/wallet.repository')
const { attachUserProfiles, getOwnedUserIds } = require('./admin.common.service')

/**
 * 分页查询消费记录
 * @param {Object} req - Express 请求对象
 * @param {number} from - 起始索引
 * @param {number} to - 结束索引
 * @returns {Promise<Object>} 流水列表结果 { total, items }
 */
async function listLedgers(req, from, to) {
  // 获取归属用户 ID 列表（超管返回 null）
  const ownedUserIds = await getOwnedUserIds(req.user)

  const { data, error, count } = await walletRepo.listLedger({
    from,
    to,
    userId: req.query.user_id,
    type: req.query.type,
    userIds: ownedUserIds,
  })

  if (error) {
    throw Object.assign(new Error(`查询消费记录失败：${error.message}`), { statusCode: 500 })
  }

  const items = await attachUserProfiles(data || [])
  return {
    total: count || 0,
    items: items.map((row) => ({
      ...row,
      amount: Math.round(Number(row.amount || 0) * 10000) / 10000,
      balance_after: Math.round(Number(row.balance_after || 0) * 10000) / 10000,
      paid_amount: Math.round(Number(row.paid_amount || 0) * 10000) / 10000,
      create_time: String(row.create_time),
    })),
  }
}

module.exports = {
  listLedgers,
}
