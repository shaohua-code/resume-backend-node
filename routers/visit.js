/**
 * 访客记录公开路由
 */

const express = require('express')
const visitController = require('../controllers/visit.controller')

const router = express.Router()

router.post('/', visitController.createVisit)
router.patch('/:id', visitController.updateDuration)

module.exports = router
