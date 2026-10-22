/**
 * 公开应用配置路由
 */
const express = require('express');
const appController = require('../controllers/app.controller');

const router = express.Router();

router.get('/public-settings', appController.getPublicSettings);

module.exports = router;
