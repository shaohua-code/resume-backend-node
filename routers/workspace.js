const express = require('express')
const { authRequired } = require('../middlewares/auth')
const controller = require('../controllers/workspace.controller')

const router = express.Router()
router.use(authRequired)
router.get('/summary', controller.getSummary)
router.get('/onboarding', controller.getOnboarding)
router.patch('/onboarding', controller.updateOnboarding)

module.exports = router
