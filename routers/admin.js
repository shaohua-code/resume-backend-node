/**
 * 管理后台路由
 * 所有接口都先校验登录和管理员身份，再按模块权限做细粒度控制。
 */

const express = require('express')
const { authRequired } = require('../middlewares/auth')
const { requireAdmin, requirePermission, requireRole } = require('../middlewares/permission')
const { PERMISSIONS, ROLES } = require('../utils/permissions')
const adminController = require('../controllers/admin.controller')

const router = express.Router()

router.use(authRequired)
router.use(requireAdmin)

// 统计与大盘
router.get('/stats', requirePermission(PERMISSIONS.ADMIN_STATS), adminController.getStats)
router.get('/dashboard', requirePermission(PERMISSIONS.ADMIN_STATS), adminController.getDashboard)

// 用户管理
router.get('/users', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.listUsers)
router.get('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.getUser)
router.patch('/users/:userId', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.updateUser)
router.post('/users/:userId/reset-password', requirePermission(PERMISSIONS.ADMIN_MANAGE_USERS), adminController.resetPassword)
router.post('/users/:userId/balance', requirePermission(PERMISSIONS.ADMIN_WALLET), adminController.adjustUserBalance)

// 邮箱认领用户
router.post('/users/claim', requirePermission(PERMISSIONS.ADMIN_CLAIM_USERS), adminController.claimUser)

// 用户额度管理
router.get('/wallets', requirePermission(PERMISSIONS.ADMIN_WALLET), adminController.listWallets)

// 当前管理员额度摘要
router.get('/wallet/summary', requirePermission(PERMISSIONS.ADMIN_WALLET), adminController.getWalletSummary)

// 消费记录
router.get('/ledgers', requirePermission(PERMISSIONS.ADMIN_VIEW_LEDGERS), adminController.listLedgers)

// 邀请链接管理
router.get('/invite-links', requirePermission(PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS), adminController.listInviteLinks)
router.post('/invite-links', requirePermission(PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS), adminController.createInviteLink)
router.patch('/invite-links/:id', requirePermission(PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS), adminController.updateInviteLink)
router.delete('/invite-links/:id', requirePermission(PERMISSIONS.ADMIN_MANAGE_INVITE_LINKS), adminController.deleteInviteLink)

// AI 调用记录
router.get('/ai-calls', requirePermission(PERMISSIONS.ADMIN_VIEW_AI_CALLS), adminController.listAiCalls)

// 简历管理
router.get('/resumes', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), adminController.listResumes)
router.get('/resumes/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_RESUMES), adminController.getResume)

// 系统配置
router.get('/configs', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), adminController.listConfigs)
router.put('/configs/:key', requirePermission(PERMISSIONS.ADMIN_SYSTEM_CONFIG), adminController.upsertConfig)

// AI 模型与任务路由（仅 SUPER_ADMIN 拥有 admin:ai_model）
router.get('/models', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.listModels)
router.post('/models', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.createModel)
router.patch('/models/rate-multiplier', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.adjustModelRates)
router.patch('/models/:id', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.updateModel)
router.delete('/models/:id', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.deleteModel)
router.get('/task-models', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.listTaskModels)
router.put('/task-models/:taskType', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.updateTaskModel)
// 全局默认业务提示词（不含输出 Schema，Schema 仅代码锁定）
router.get('/task-prompts', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.listTaskPrompts)
router.put('/task-prompts/:taskType', requirePermission(PERMISSIONS.ADMIN_AI_MODEL), adminController.upsertTaskPrompt)

// 通用 CRUD：公告
const crudConfigs = [
  { path: '/announcements', table: 'announcement', permission: PERMISSIONS.ADMIN_ANNOUNCEMENT },
]

crudConfigs.forEach(({ path, table, permission }) => {
  router.get(path, requirePermission(permission), adminController.listCrudItems(table))
  router.post(path, requirePermission(permission), adminController.createCrudItem(table))
  router.patch(`${path}/:id`, requirePermission(permission), adminController.updateCrudItem(table))
  router.delete(`${path}/:id`, requirePermission(permission), adminController.deleteCrudItem(table))
})

// 用户反馈（仅 SUPER_ADMIN）
router.get('/feedbacks', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), adminController.listFeedbacks)
router.get('/feedbacks/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_FEEDBACK), adminController.getFeedback)

// 访客记录（仅 SUPER_ADMIN）
router.get('/visits', requirePermission(PERMISSIONS.ADMIN_VIEW_VISITS), adminController.listVisits)

// 充值二维码管理（按 admin_id 隔离）
router.get('/recharge-config', requirePermission(PERMISSIONS.ADMIN_RECHARGE_MANAGE), adminController.getRechargeConfig)
router.put('/recharge-config', requirePermission(PERMISSIONS.ADMIN_RECHARGE_MANAGE), adminController.saveRechargeConfig)

// 充值记录与审核
router.get('/recharge-requests', requirePermission(PERMISSIONS.ADMIN_VIEW_RECHARGE_REQUESTS), adminController.listRechargeRequests)
router.get('/recharge-requests/:id', requirePermission(PERMISSIONS.ADMIN_VIEW_RECHARGE_REQUESTS), adminController.getRechargeRequest)
router.get('/recharge-requests/:id/email-preview', requirePermission(PERMISSIONS.ADMIN_VIEW_RECHARGE_REQUESTS), adminController.previewRechargeEmail)
router.post('/recharge-requests/:id/approve', requirePermission(PERMISSIONS.ADMIN_APPROVE_RECHARGE), adminController.approveRechargeRequest)
router.delete(
  '/recharge-requests/:id',
  requireRole(ROLES.SUPER_ADMIN),
  adminController.deleteRechargeRequest,
)
router.get('/recharge-email-templates', requirePermission(PERMISSIONS.ADMIN_RECHARGE_EMAIL_TEMPLATE), adminController.getRechargeEmailTemplates)
router.put('/recharge-email-templates', requirePermission(PERMISSIONS.ADMIN_RECHARGE_EMAIL_TEMPLATE), adminController.updateRechargeEmailTemplates)

module.exports = router
