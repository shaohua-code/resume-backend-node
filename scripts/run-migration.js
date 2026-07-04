/**
 * 检查并执行 ai_call_record token/cost 迁移
 * 用法：node scripts/run-migration.js
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { supabaseAdmin } = require('../supabaseClient')

const REQUIRED_COLUMNS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']
const MIGRATION_FILE = path.join(__dirname, '../supabase/migrations/20260704_ai_call_tokens_cost.sql')

async function checkColumns() {
  const { data, error } = await supabaseAdmin
    .from('ai_call_record')
    .select(REQUIRED_COLUMNS.join(','))
    .limit(1)

  if (error) {
    const missing = error.message.includes('column') || error.code === '42703'
    return { exists: false, error: error.message, missing }
  }
  return { exists: true, sample: data }
}

async function runMigrationStatements() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8')
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'))

  for (const stmt of statements) {
    const { error } = await supabaseAdmin.rpc('exec_sql', { query: stmt })
    if (error) {
      throw new Error(`RPC exec_sql 不可用或执行失败: ${error.message}\n请在 Supabase SQL Editor 手动执行: ${MIGRATION_FILE}`)
    }
  }
}

async function main() {
  console.log('[migration] 检查 ai_call_record 新列...')
  const check = await checkColumns()

  if (check.exists) {
    console.log('[migration] ✓ 列已存在:', REQUIRED_COLUMNS.join(', '))
    if (check.sample) console.log('[migration] 示例行:', JSON.stringify(check.sample[0] || {}))
    return
  }

  console.log('[migration] 列缺失或未就绪:', check.error)
  console.log('[migration] 尝试通过 RPC 执行迁移...')

  try {
    await runMigrationStatements()
    const recheck = await checkColumns()
    if (recheck.exists) {
      console.log('[migration] ✓ 迁移执行成功')
      return
    }
    throw new Error('迁移后列仍不可用')
  } catch (e) {
    console.error('[migration]', e.message)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[migration] 失败:', e.message)
  process.exit(1)
})
