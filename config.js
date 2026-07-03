/**
 * 项目全局配置模块
 * 使用 dotenv 从 .env 文件加载环境变量
 * 包含：Supabase 配置、DeepSeek API、跨域配置等
 */

require('dotenv').config();

const settings = {
  // 服务端口
  PORT: parseInt(process.env.PORT || '8000', 10),

  // Supabase 配置
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '', // 用于 Auth（验证码登录）
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '', // 服务端管理权限，操作数据库

  // DeepSeek API 配置
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  DEEPSEEK_MODEL_RESUME_GENERATE: process.env.DEEPSEEK_MODEL_RESUME_GENERATE || '',
  DEEPSEEK_MODEL_PROJECT_OPTIMIZE: process.env.DEEPSEEK_MODEL_PROJECT_OPTIMIZE || '',
  DEEPSEEK_MODEL_JD_MATCH: process.env.DEEPSEEK_MODEL_JD_MATCH || '',
  DEEPSEEK_MODEL_SCORE: process.env.DEEPSEEK_MODEL_SCORE || '',
  DEEPSEEK_MODEL_PDF_OPTIMIZE: process.env.DEEPSEEK_MODEL_PDF_OPTIMIZE || '',

  // 跨域资源共享配置
  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 应用前端地址，用于邮件重置密码链接回调
  APP_FRONTEND_URL: process.env.APP_FRONTEND_URL || 'http://localhost:5173',
};

// 启动配置检查
if (!settings.SUPABASE_URL) {
  console.warn('[配置警告] SUPABASE_URL 未配置！');
}
if (!settings.SUPABASE_ANON_KEY) {
  console.warn('[配置警告] SUPABASE_ANON_KEY 未配置！Auth 功能不可用');
}
if (!settings.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[配置警告] SUPABASE_SERVICE_ROLE_KEY 未配置！后端无法操作数据库');
}
if (settings.DEEPSEEK_API_KEY && settings.DEEPSEEK_API_KEY.trim()) {
  console.log(`[配置] DeepSeek API Key 已加载（前缀：${settings.DEEPSEEK_API_KEY.slice(0, 10)}...）`);
} else {
  console.warn('[配置警告] DeepSeek API Key 未配置！');
}

module.exports = { settings };
