/**
 * 管理后台控制器
 * 处理管理后台各模块的 HTTP 请求响应，调用对应 service 执行业务逻辑
 */

const dashboardService = require('../services/admin/admin.dashboard.service');
const userService = require('../services/admin/admin.user.service');
const aiCallService = require('../services/admin/admin.aiCall.service');
const resumeService = require('../services/admin/admin.resume.service');
const configService = require('../services/admin/admin.config.service');
const crudService = require('../services/admin/admin.crud.service');
const aiModelService = require('../services/admin/admin.aiModel.service');
const feedbackService = require('../services/admin/admin.feedback.service');
const walletService = require('../services/wallet/wallet.service');
const ledgerService = require('../services/admin/admin.ledger.service');
const inviteService = require('../services/admin/admin.invite.service');
const visitService = require('../services/admin/admin.visit.service');
const rechargeService = require('../services/admin/admin.recharge.service');
const rechargeRequestService = require('../services/admin/admin.rechargeRequest.service');

/**
 * 解析分页参数
 * @param {Object} req - Express 请求对象
 * @returns {Object} 分页信息 { page, size, from, to }
 */
function parsePagination(req) {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const size = Math.min(Math.max(parseInt(req.query.size || '10', 10), 1), 100);
  return { page, size, from: (page - 1) * size, to: page * size - 1 };
}

/**
 * 统一错误响应
 * @param {Object} res - Express 响应对象
 * @param {Error} err - 错误对象
 * @returns {Object} Express 响应
 */
function handleError(res, err) {
  return res.status(err.statusCode || 500).json({ detail: err.message });
}

/**
 * 获取顶部统计卡片数据
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function getStats(req, res) {
  try {
    const data = await dashboardService.getStats(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取数据中心大盘聚合数据
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
/**
 * 获取数据中心大盘数据（支持时间范围筛选）
 * 查询参数：range=今日/昨日/7日/30日/年度
 */
async function getDashboard(req, res) {
  try {
    // 将请求对象传递给服务层，用于读取查询参数
    const data = await dashboardService.getDashboard(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取用户列表
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listUsers(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await userService.listUsers(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取单个用户详情
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function getUser(req, res) {
  try {
    const data = await userService.getUser(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 更新用户信息
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function updateUser(req, res) {
  try {
    const data = await userService.updateUser(req);
    return res.json({ success: true, data, message: '用户已更新' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 重置用户密码
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function resetPassword(req, res) {
  try {
    const data = await userService.resetPassword(req);
    return res.json({ success: true, data, message: '重置链接已生成' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取 AI 调用记录列表
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listAiCalls(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await aiCallService.listAiCalls(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取简历列表
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listResumes(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await resumeService.listResumes(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取单份简历详情
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function getResume(req, res) {
  try {
    const data = await resumeService.getResume(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取系统配置列表
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listConfigs(req, res) {
  try {
    const items = await configService.listConfigs();
    return res.json({ success: true, items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 新增或更新系统配置
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function upsertConfig(req, res) {
  try {
    const data = await configService.upsertConfig(req);
    return res.json({ success: true, data, message: '配置已保存' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 查询通用 CRUD 列表
 * @param {string} table - 表名
 * @returns {Function} Express 处理函数
 */
function listCrudItems(table) {
  return async (req, res) => {
    try {
      const items = await crudService.listItems(table);
      return res.json({ success: true, items });
    } catch (err) {
      return handleError(res, err);
    }
  };
}

/**
 * 创建通用 CRUD 记录
 * @param {string} table - 表名
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Function} Express 处理函数
 */
function createCrudItem(table, idColumn = 'id') {
  return async (req, res) => {
    try {
      const data = await crudService.createItem(req, table, req.body, idColumn);
      return res.json({ success: true, data, message: '创建成功' });
    } catch (err) {
      return handleError(res, err);
    }
  };
}

/**
 * 更新通用 CRUD 记录
 * @param {string} table - 表名
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Function} Express 处理函数
 */
function updateCrudItem(table, idColumn = 'id') {
  return async (req, res) => {
    try {
      const data = await crudService.updateItem(req, table, req.params.id, req.body, idColumn);
      return res.json({ success: true, data, message: '更新成功' });
    } catch (err) {
      return handleError(res, err);
    }
  };
}

/**
 * 删除通用 CRUD 记录
 * @param {string} table - 表名
 * @param {string} [idColumn='id'] - 主键列名
 * @returns {Function} Express 处理函数
 */
function deleteCrudItem(table, idColumn = 'id') {
  return async (req, res) => {
    try {
      await crudService.deleteItem(req, table, req.params.id, idColumn);
      return res.json({ success: true, message: '删除成功' });
    } catch (err) {
      return handleError(res, err);
    }
  };
}

// ========== AI 模型与任务模型配置（仅 admin:ai_model） ==========

/** 返回模型主数据，供模型管理页展示。 */
async function listModels(req, res) {
  try {
    const items = await aiModelService.listModels();
    return res.json({ success: true, items });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 创建模型；字段白名单与价格校验由专用 service 处理。 */
async function createModel(req, res) {
  try {
    const data = await aiModelService.createModel(req, req.body);
    return res.json({ success: true, data, message: '创建成功' });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 更新模型，并保护仍被任务引用的类型与启用状态。 */
async function updateModel(req, res) {
  try {
    const data = await aiModelService.updateModel(req, req.params.id, req.body);
    return res.json({ success: true, data, message: '更新成功' });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 删除未被任何任务引用的模型。 */
async function deleteModel(req, res) {
  try {
    await aiModelService.deleteModel(req, req.params.id);
    return res.json({ success: true, message: '删除成功' });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 返回完整任务目录、当前绑定和可选模型。 */
async function listTaskModels(req, res) {
  try {
    const data = await aiModelService.listTaskModels();
    return res.json({ success: true, ...data });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 切换指定任务的模型，后端强制校验能力类型。 */
async function updateTaskModel(req, res) {
  try {
    const data = await aiModelService.updateTaskModel(req, req.params.taskType, req.body?.model_id);
    return res.json({ success: true, data, message: '任务模型已更新' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取用户反馈列表
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listFeedbacks(req, res) {
  try {
    const { page, size, from, to } = parsePagination(req);
    const result = await feedbackService.listFeedbacks(req, from, to);
    return res.json({
      success: true,
      items: result.items,
      total: result.total,
      page,
      size,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取单条用户反馈详情
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function getFeedback(req, res) {
  try {
    const data = await feedbackService.getFeedback(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 调整用户额度
 */
async function adjustUserBalance(req, res) {
  try {
    const data = await walletService.adjustBalanceFromRequest(req);
    return res.json({ success: true, data, message: '额度已调整' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取用户钱包列表
 */
async function listWallets(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await walletService.listWalletsForAdmin(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取消费记录列表
 */
async function listLedgers(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await ledgerService.listLedgers(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 通过邮箱认领用户
 */
async function claimUser(req, res) {
  try {
    const data = await userService.claimUser(req);
    return res.json({ success: true, data, message: '认领成功' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取邀请链接列表
 */
async function listInviteLinks(req, res) {
  try {
    const result = await inviteService.listInviteLinks(req);
    return res.json({ success: true, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 创建邀请链接
 */
async function createInviteLink(req, res) {
  try {
    const data = await inviteService.createInviteLink(req);
    return res.json({ success: true, data, message: '邀请链接已生成' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 更新邀请链接
 */
async function updateInviteLink(req, res) {
  try {
    const data = await inviteService.updateInviteLink(req);
    return res.json({ success: true, data, message: '邀请链接已更新' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 删除邀请链接
 */
async function deleteInviteLink(req, res) {
  try {
    await inviteService.deleteInviteLink(req);
    return res.json({ success: true, message: '邀请链接已删除' });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取当前管理员额度摘要
 */
async function getWalletSummary(req, res) {
  try {
    const data = await walletService.getWalletSummary(req);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 访客记录列表（仅超级管理员）
 */
async function listVisits(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await visitService.listVisits(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 获取当前管理员的充值二维码配置
 */
async function getRechargeConfig(req, res) {
  try {
    const data = await rechargeService.getOwnConfig(req.user.id);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/**
 * 保存当前管理员的充值二维码配置
 */
async function saveRechargeConfig(req, res) {
  try {
    const { payment_qrcode_url, contact_qrcode_url, payment_platform, contact_platform } = req.body || {};
    const data = await rechargeService.upsertOwnConfig(req.user.id, {
      payment_qrcode_url,
      contact_qrcode_url,
      payment_platform,
      contact_platform,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 充值记录列表 */
async function listRechargeRequests(req, res) {
  try {
    const { from, to } = parsePagination(req);
    const result = await rechargeRequestService.listRequests(req, from, to);
    return res.json({ success: true, total: result.total, items: result.items });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 充值记录详情 */
async function getRechargeRequest(req, res) {
  try {
    const data = await rechargeRequestService.getRequestDetail(req, req.params.id);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 充值邮件预览 */
async function previewRechargeEmail(req, res) {
  try {
    const type = req.query.type || 'admin_notify';
    const data = await rechargeRequestService.previewEmail(req, req.params.id, type);
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 审核充值入账 */
async function approveRechargeRequest(req, res) {
  try {
    const data = await rechargeRequestService.approveRequest(req, req.params.id, req.body || {});
    return res.json({ success: true, data, message: '充值已入账' });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 删除待充值记录（仅超管） */
async function deleteRechargeRequest(req, res) {
  try {
    const data = await rechargeRequestService.deleteRequest(req, req.params.id);
    return res.json({ success: true, data, message: '充值记录已删除' });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 读取充值邮件模板（超管） */
async function getRechargeEmailTemplates(req, res) {
  try {
    const data = await rechargeRequestService.getEmailTemplates();
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err);
  }
}

/** 保存充值邮件模板（超管） */
async function updateRechargeEmailTemplates(req, res) {
  try {
    const data = await rechargeRequestService.updateEmailTemplates(req.body || {});
    return res.json({ success: true, data, message: '邮件模板已保存' });
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = {
  getStats,
  getDashboard,
  listUsers,
  getUser,
  updateUser,
  resetPassword,
  adjustUserBalance,
  listWallets,
  listAiCalls,
  listResumes,
  getResume,
  listConfigs,
  upsertConfig,
  listCrudItems,
  createCrudItem,
  updateCrudItem,
  deleteCrudItem,
  listModels,
  createModel,
  updateModel,
  deleteModel,
  listTaskModels,
  updateTaskModel,
  listFeedbacks,
  getFeedback,
  // 新增导出
  listLedgers,
  claimUser,
  listInviteLinks,
  createInviteLink,
  updateInviteLink,
  deleteInviteLink,
  getWalletSummary,
  listVisits,
  getRechargeConfig,
  saveRechargeConfig,
  listRechargeRequests,
  getRechargeRequest,
  previewRechargeEmail,
  approveRechargeRequest,
  deleteRechargeRequest,
  getRechargeEmailTemplates,
  updateRechargeEmailTemplates,
};
