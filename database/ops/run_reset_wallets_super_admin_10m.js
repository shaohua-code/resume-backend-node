/**
 * 一次性执行：清空余额相关数据，超管重置为 1000 万
 * 用法：node database/ops/run_reset_wallets_super_admin_10m.js
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const sqlPath = path.join(__dirname, 'reset_wallets_super_admin_10m.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')
  await client.query(sql)

  const { rows: counts } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM balance_ledger) AS ledger_count,
      (SELECT COUNT(*)::int FROM ai_call_record) AS ai_call_count,
      (SELECT COUNT(*)::int FROM export_record) AS export_count,
      (SELECT COUNT(*)::int FROM recharge_request) AS recharge_count
  `)

  const { rows: superRows } = await client.query(`
    SELECT w.user_id, w.balance, w.total_consumed, p.email
    FROM user_wallet w
    JOIN user_profile p ON p.user_id = w.user_id
    WHERE p.role = 'SUPER_ADMIN'
    ORDER BY p.create_time ASC
    LIMIT 1
  `)

  const { rows: otherRows } = await client.query(`
    SELECT COUNT(*)::int AS nonzero_others
    FROM user_wallet w
    JOIN user_profile p ON p.user_id = w.user_id
    WHERE p.role <> 'SUPER_ADMIN'
      AND (w.balance <> 0 OR w.total_consumed <> 0)
  `)

  const { rows: configs } = await client.query(`
    SELECT config_key, config_value
    FROM system_config
    WHERE config_key IN ('super_admin_total_quota', 'register_gift_amount')
    ORDER BY config_key
  `)

  console.log('表清空校验：', counts[0])
  console.log('超管钱包：', superRows[0] || null)
  console.log('非超管非零钱包数：', otherRows[0]?.nonzero_others)
  console.log('系统配置：', configs)

  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
