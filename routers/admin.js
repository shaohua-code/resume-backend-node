/**
 * 管理后台路由
 * 所有接口都先校验登录和管理员身份，再按模块权限做细粒度控制。
 * 具体业务逻辑已下沉到 admin.controller，本文件仅负责路由定义与权限挂载。
 */

const express = require('express');
const { authRequired } = require('../middlewares/auth');
const { requireAdmin, requirePermission } = require('../middlewares/permission');
const { PERMISSIONS } = require('../utils/permissions');
const adminController = require('../controllers/admin.controller');

const router = express.Router();

router.use(authRequired);
router.use(requireAdmin);

// 统计与大盘
router.get('/stats', requirePermission(PERMISSIONS.ADMIN_STATS), adminController.getStats);
router.get('/dashboard', requirePermission(PERMISSIONS.ADMIN_STATS), adminController.getDashboard);

// 用户管理
router.get('/users', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.listUsers);
router.get('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.getUser);
router.patch('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.updateUser);
router.post('/users/:userId/reset-password', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.resetPassword);

// 订单管理
router.get('/orders', requirePermission(PERMISSIONS.ADMIN_VIEW_ORDERS), adminController.listOrders);
router.post('/orders', requirePermission(PERMISSIONS.ADMIN_MANAGE_ORDERS), adminController.createOrder);
router.patch('/orders/:id', requirePermission(PERMISSIONS.ADMIN_MANAGE_ORDERS), adminController.updateOrder);

// AI 调用记录
router.get('/ai-calls', requirePermission(PERMISSIONS.ADMIN_VIEW_AI_CALLS), adminController.listAiCalls);

// 简历管理
router.get('/resumes', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), adminController.listResumes);
router.get('/resumes/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), adminController.getResume);

// 系统配置
router.get('/configs', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), adminController.listConfigs);
router.put('/configs/:key', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), adminController.upsertConfig);

// 通用 CRUD：套餐/公告/模型
const crudConfigs = [
  { path: '/plans', table: 'membership_plan', permission: PERMISSIONS.ADMIN_MEMBERSHIP_PLAN },
  { path: '/announcements', table: 'announcement', permission: PERMISSIONS.ADMIN_ANNOUNCEMENT },
  { path: '/models', table: 'ai_model', permission: PERMISSIONS.ADMIN_AI_MODEL },
];

crudConfigs.forEach(({ path, table, permission }) => {
  router.get(path, requirePermission(permission), adminController.listCrudItems(table));
  router.post(path, requirePermission(permission), adminController.createCrudItem(table));
  router.patch(`${path}/:id`, requirePermission(permission), adminController.updateCrudItem(table));
  router.delete(`${path}/:id`, requirePermission(permission), adminController.deleteCrudItem(table));
});

// 用户反馈（仅 SUPER_ADMIN）
router.get('/feedbacks', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), adminController.listFeedbacks);
router.get('/feedbacks/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), adminController.getFeedback);

module.exports = router;
