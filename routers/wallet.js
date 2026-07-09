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

module.exports = router
