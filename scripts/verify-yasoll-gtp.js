require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Client } = require('pg')
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const r = await c.query(
    `SELECT id, name, model_key, provider, enabled
     FROM ai_model WHERE provider = 'yasoll'`
  )
  console.log(JSON.stringify({ yasoll_models: r.rows }, null, 2))
  await c.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
