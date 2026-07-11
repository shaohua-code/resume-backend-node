/**
 * PostgreSQL 数据库客户端
 * 导出 dbAdmin（来自 pgCompat 查询兼容层）
 */

const { pgAdmin } = require('./lib/pgCompat')

const dbAdmin = pgAdmin

module.exports = { dbAdmin, pgAdmin }
