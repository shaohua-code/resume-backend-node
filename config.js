/**
 * 项目全局配置模块
 */

require('dotenv').config()
const path = require('path')

const settings = {
  PORT: parseInt(process.env.PORT || '8000', 10),

  // PostgreSQL 直连
  DATABASE_URL: process.env.DATABASE_URL || '',

  // JWT 认证
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production',
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || '1h',
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || '7d',

  // QQ 邮箱 SMTP
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: process.env.SMTP_SECURE !== 'false',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',

  // DeepSeek API
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  DEEPSEEK_MODEL_RESUME_GENERATE: process.env.DEEPSEEK_MODEL_RESUME_GENERATE || '',
  DEEPSEEK_MODEL_PROJECT_OPTIMIZE: process.env.DEEPSEEK_MODEL_PROJECT_OPTIMIZE || '',
  DEEPSEEK_MODEL_JD_MATCH: process.env.DEEPSEEK_MODEL_JD_MATCH || '',
  DEEPSEEK_MODEL_SCORE: process.env.DEEPSEEK_MODEL_SCORE || '',
  DEEPSEEK_MODEL_PDF_OPTIMIZE: process.env.DEEPSEEK_MODEL_PDF_OPTIMIZE || '',
  // JD 岗位描述流式优化简历（缺省复用 PDF 优化模型）
  DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE: process.env.DEEPSEEK_MODEL_JD_RESUME_OPTIMIZE || '',
  // JD 图片 OCR 提取（多模态视觉模型）
  DEEPSEEK_MODEL_VISION: process.env.DEEPSEEK_MODEL_VISION || '',

  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  APP_FRONTEND_URL: process.env.APP_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:5173',

  // 上传文件根目录（生产环境建议 /var/www/resume-uploads，独立于 Git 仓库）
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'),
}

if (!settings.DATABASE_URL) {
  console.warn('[配置警告] DATABASE_URL 未配置！')
}
if (settings.JWT_SECRET === 'change-me-in-production') {
  console.warn('[配置警告] JWT_SECRET 使用默认值，生产环境请务必修改！')
}
if (!settings.SMTP_HOST) {
  console.warn('[配置警告] SMTP 未配置，验证码将打印到控制台')
}
if (settings.DEEPSEEK_API_KEY?.trim()) {
  console.log(`[配置] DeepSeek API Key 已加载（前缀：${settings.DEEPSEEK_API_KEY.slice(0, 10)}...）`)
} else {
  console.warn('[配置警告] DeepSeek API Key 未配置！')
}

module.exports = { settings }
