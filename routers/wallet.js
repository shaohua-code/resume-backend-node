/**
 * 钱包路由
 * 用户侧余额与流水查询
 */

const express = require('express')
const { authRequired } = require('../middlewares/auth')
const walletController = require('../controllers/wallet.controller')

const router = express.Router()

router.use(authRequired)

// 查询当前用户余额
router.get('/balance', walletController.getBalance)
// 查询当前用户流水
router.get('/ledger', walletController.listLedger)
// 获取充值二维码（付款码 + 管理员联系码）
router.get('/recharge-info', walletController.getRechargeInfo)
// 用户提交充值凭证
router.post('/recharge-request', walletController.submitRechargeRequest)

module.exports = router
