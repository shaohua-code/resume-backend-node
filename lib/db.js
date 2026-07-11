/**
 * PostgreSQL 连接池
 */

const { Pool } = require('pg')
const { settings } = require('../config')

let pool = null

function getPool() {
  if (!pool) {
    if (!settings.DATABASE_URL) {
      throw new Error('DATABASE_URL 未配置')
    }
    pool = new Pool({
      connectionString: settings.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    })
    pool.on('error', (err) => {
      console.error('[db] 连接池异常:', err.message)
    })
  }
  return pool
}

async function query(text, params = []) {
  return getPool().query(text, params)
}

async function ping() {
  await query('SELECT 1')
  return true
}

module.exports = { getPool, query, ping }
