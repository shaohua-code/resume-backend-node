/**
 * 验证 ai_call_record / ai_model 迁移列是否存在
 */
require('dotenv').config()
const { supabaseAdmin } = require('../supabaseClient')

const REQUIRED_AI_CALL_COLUMNS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']
const REQUIRED_AI_MODEL_COLUMNS = ['input_price_per_million', 'output_price_per_million']

async function checkTableColumns(table, columns) {
  const { data, error } = await supabaseAdmin.from(table).select(columns.join(',')).limit(1)
  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true, sample: data }
}

async function main() {
  console.log('检查 ai_call_record 新列...')
  const callResult = await checkTableColumns('ai_call_record', REQUIRED_AI_CALL_COLUMNS)
  if (!callResult.ok) {
    console.error('ai_call_record 列缺失或不可访问:', callResult.error)
    process.exit(1)
  }
  console.log('ai_call_record 列验证通过:', REQUIRED_AI_CALL_COLUMNS.join(', '))

  console.log('检查 ai_model 单价列...')
  const modelResult = await checkTableColumns('ai_model', REQUIRED_AI_MODEL_COLUMNS)
  if (!modelResult.ok) {
    console.error('ai_model 列缺失或不可访问:', modelResult.error)
    process.exit(1)
  }
  console.log('ai_model 列验证通过:', REQUIRED_AI_MODEL_COLUMNS.join(', '))

  const { data: models } = await supabaseAdmin
    .from('ai_model')
    .select('model_key, input_price_per_million, output_price_per_million')
  console.log('ai_model 定价配置:', JSON.stringify(models, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
