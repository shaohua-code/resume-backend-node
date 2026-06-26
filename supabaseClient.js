/**
 * Supabase 客户端工厂
 * 提供两个客户端：
 * 1. supabaseAuth: 使用 anon key，用于 Auth 相关操作（发送验证码、验证 token）
 * 2. supabaseAdmin: 使用 service_role key，用于服务端操作数据库（绕过 RLS 策略）
 *
 * 重要：service_role key 拥有完全权限，绝对不能暴露给前端
 *
 * Node.js < 22 没有原生 WebSocket，需要通过 ws 包注入到 realtime.transport
 * 否则启动时会报：Node.js 18 detected without native WebSocket support
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { settings } = require('./config');

// 通用客户端选项：服务端不需要持久化会话，并为 Realtime 注入 ws 实现
const commonOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false, // 服务端无需持久化会话
  },
  realtime: {
    transport: WebSocket, // Node.js < 22 必须注入 ws，避免运行时报错
  },
};

// Auth 客户端：用于邮箱验证码发送、登录验证
const supabaseAuth = createClient(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY, commonOptions);

// Admin 客户端：服务端操作 Postgres 数据表，绕过 Row Level Security
const supabaseAdmin = createClient(
  settings.SUPABASE_URL,
  settings.SUPABASE_SERVICE_ROLE_KEY,
  commonOptions,
);

module.exports = { supabaseAuth, supabaseAdmin };
