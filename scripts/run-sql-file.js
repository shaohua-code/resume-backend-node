/**
 * 一次性执行 SQL 文件（按分号拆分，跳过纯注释行）
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const filePath = process.argv[2]
if (!filePath) {
  console.error('用法: node scripts/run-sql-file.js <path-to.sql>')
  process.exit(1)
}

const sql = fs.readFileSync(path.resolve(filePath), 'utf8')
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s && !s.split('\n').every((line) => !line.trim() || line.trim().startsWith('--')))

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    for (const statement of statements) {
      await client.query(statement)
    }
    console.log('[OK] 已执行', statements.length, '条语句')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('[FAIL]', err.message)
  process.exit(1)
})
