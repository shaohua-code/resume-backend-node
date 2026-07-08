/**
 * 简历路由模块
 * 挂载路径前缀：/api/resume
 * 职责：简历 CRUD、简历列表/详情、导出记录
 * 数据存储于 Supabase Postgres，通过 supabaseAdmin 客户端操作（绕过 RLS）
 *
 * Supabase 数据表约定：
 * - resume         (id bigint pk, user_id uuid, title text, resume_json text, template_id int, score int, create_time timestamp, update_time timestamp)
 * - export_record  (id bigint pk, user_id uuid, resume_id bigint, create_time timestamp)
 *
 * 注意：user_id 在 Supabase 中是 uuid 类型，对应 auth.users.id
 */

const express = require('express');
const { authRequired } = require('../middlewares/auth');
const { PERMISSIONS, hasPermission } = require('../utils/permissions');
const { validate } = require('../middlewares/validate');
const resumeController = require('../controllers/resume.controller');
const resumeValidator = require('../validators/resume.validator');

const router = express.Router();

// 所有简历接口都需要登录
router.use(authRequired);

/**
 * 创建简历接口
 * AI 生成、上传优化、首次保存时使用，仅做 insert
 * POST /api/resume/create
 */
router.post('/create', resumeValidator.create, validate, resumeController.create);

/**
 * 更新简历接口
 * id 必传，仅做 update
 * PUT /api/resume/update/:id
 */
router.put('/update/:id', resumeValidator.update, validate, resumeController.update);

/**
 * 保存简历接口（兼容旧调用）
 * 如果传了 id 则更新已有简历，否则创建新简历
 * POST /api/resume/save
 */
router.post('/save', resumeValidator.save, validate, resumeController.save);

/**
 * 获取简历列表接口
 * 分页返回当前用户的所有简历
 * GET /api/resume/list
 */
router.get('/list', resumeController.list);

/**
 * 获取简历详情接口
 * GET /api/resume/detail
 */
router.get('/detail', resumeValidator.detail, validate, resumeController.detail);

/**
 * 删除简历接口
 * 仅能删除自己的简历
 * DELETE /api/resume/delete
 */
router.delete('/delete', resumeValidator.remove, validate, resumeController.remove);

/**
 * 批量删除简历接口
 * POST /api/resume/batch-delete
 * body: { ids: [id1, id2, ...] }
 */
router.post('/batch-delete', resumeValidator.batchRemove, validate, resumeController.batchRemove);

/**
 * 获取当前用户简历数量与上限
 * GET /api/resume/count
 */
router.get('/count', resumeController.count);

/**
 * 记录导出操作接口
 * POST /api/resume/export
 */
router.post('/export', resumeValidator.recordExport, validate, (req, res, next) => {
  // 导出权限校验：仅 VIP 可导出
  if (!hasPermission(req.user.role, PERMISSIONS.VIP_EXPORT)) {
    return res.status(403).json({ detail: '普通用户暂不支持导出，请升级 VIP 后使用' });
  }
  next();
}, resumeController.recordExport);

module.exports = router;
