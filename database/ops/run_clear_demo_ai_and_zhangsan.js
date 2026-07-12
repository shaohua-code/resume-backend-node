/**
 * 一次性执行：清理 AI 调用 + 「张三」测试简历
 * 用法：node database/ops/run_clear_demo_ai_and_zhangsan.js
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const sqlPath = path.join(__dirname, 'clear_demo_ai_and_zhangsan_resumes.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')
  await client.query(sql)

  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM ai_call_record) AS ai_calls,
      (SELECT COUNT(*)::int FROM resume WHERE title LIKE '%张三%') AS zhangsan_resumes,
      (SELECT COUNT(*)::int FROM resume) AS resume_total
  `)
  console.log('清理完成：', rows[0])
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
