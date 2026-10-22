require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const jd = await client.query(
    `SELECT t.task_type, m.model_key, m.provider, t.thinking_enabled
     FROM ai_task_model t
     JOIN ai_model m ON m.id = t.model_id
     WHERE t.task_type = 'jd_image_extract'`
  )
  const legacy = await client.query(
    `SELECT count(*)::int AS n FROM ai_model
     WHERE provider = 'dashscope' OR model_key = 'qwen3.6-flash'`
  )
  console.log(JSON.stringify({ jd_image_extract: jd.rows, dashscope_model_rows: legacy.rows[0].n }, null, 2))
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
