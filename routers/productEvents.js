const express = require('express')
const controller = require('../controllers/productEvent.controller')

const router = express.Router()
router.post('/', controller.collect)

module.exports = router
