/**
 * 路由总入口
 * 按业务模块聚合所有路由，统一导出给 app.js 挂载
 */

const express = require('express')
const authRouter = require('./auth')
const aiRouter = require('./ai')
const pdfRouter = require('./pdf')
const resumeRouter = require('./resume')
const adminRouter = require('./admin')
const uploadRouter = require('./upload')
const feedbackRouter = require('./feedback')

const router = express.Router()

router.use('/auth', authRouter)
router.use('/ai', aiRouter)
router.use('/pdf', pdfRouter)
router.use('/resume', resumeRouter)
router.use('/admin', adminRouter)
router.use('/upload', uploadRouter)
router.use('/feedback', feedbackRouter)

module.exports = router
