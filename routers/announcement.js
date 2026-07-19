/**
 * 用户公告路由（需登录）
 */

const express = require('express')
const { authRequired } = require('../middlewares/auth')
const announcementController = require('../controllers/announcement.controller')

const router = express.Router()

router.use(authRequired)
router.get('/active', announcementController.listActive)

module.exports = router
