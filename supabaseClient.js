/**
 * 数据库客户端（替代 Supabase JS SDK）
 * 保持 supabaseAdmin 命名，兼容现有 repository 层
 */

const { pgAdmin } = require('./lib/pgCompat')

const supabaseAdmin = pgAdmin

module.exports = { supabaseAdmin, pgAdmin }
