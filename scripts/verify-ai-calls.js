/**
 * 验证 AI 调用记录：触发各 AI 接口并检查 model/token/cost
 * 用法：node scripts/verify-ai-calls.js [--base http://localhost:8000]
 */
require('dotenv').config()
const axios = require('axios')
const { supabaseAdmin } = require('../supabaseClient')

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:8000').split('=')[1]
const AI_ENDPOINTS = [
  { taskType: 'project_optimize', method: 'post', path: '/api/resume/optimize', body: { project_description: '负责前端开发，使用 Vue3 完成后台管理系统', target_position: '前端工程师' } },
  { taskType: 'jd_match', method: 'post', path: '/api/resume/match', body: null },
  { taskType: 'score', method: 'post', path: '/api/resume/score', body: null, query: true },
]

async function getTestContext() {
  const { data: profiles } = await supabaseAdmin
    .from('user_profile')
    .select('user_id, role, status')
    .eq('status', 'ACTIVE')
    .in('role', ['SUPER_ADMIN', 'ADMIN', 'VIP', 'USER'])
    .limit(5)

  if (!profiles?.length) throw new Error('无可用测试用户')

  let resume = null
  let userId = profiles[0].user_id
  for (const p of profiles) {
    const { data } = await supabaseAdmin
      .from('resume')
      .select('id, resume_json')
      .eq('user_id', p.user_id)
      .order('update_time', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (data) {
      resume = data
      userId = p.user_id
      break
    }
  }
  if (!resume) throw new Error('无可用测试简历，请先创建一份简历')

  const { data: linkData, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: (await supabaseAdmin.auth.admin.getUserById(userId)).data.user.email,
  })
  if (error) throw new Error(`生成 token 失败: ${error.message}`)

  const token = linkData.properties?.hashed_token
    ? await exchangeToken(linkData.properties.hashed_token)
    : linkData.properties?.access_token

  if (!token) {
    const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
    const email = users?.users?.[0]?.email
    if (!email) throw new Error('无法获取用户 email 生成 token')
    const { data: sessionData, error: sessionErr } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password: process.env.TEST_USER_PASSWORD || '',
    })
    if (sessionErr || !sessionData?.session?.access_token) {
      throw new Error('请设置 TEST_USER_PASSWORD 或确保 generateLink 可用')
    }
    return { token: sessionData.session.access_token, resume, userId }
  }

  return { token, resume, userId }
}

async function exchangeToken(hashedToken) {
  const { data, error } = await supabaseAdmin.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  })
  if (error) throw error
  return data.session.access_token
}

async function callAi(token, ep, resume) {
  let url = `${BASE}${ep.path}`
  let body = ep.body
  if (ep.taskType === 'jd_match') {
    body = { resume_id: resume.id, jd_text: '要求 Vue3、TypeScript、前端工程化经验' }
  } else if (ep.taskType === 'score') {
    url += `?resume_id=${resume.id}`
    body = { resume_id: resume.id }
  }
  const headers = { Authorization: `Bearer ${token}` }
  const res = await axios({ method: ep.method, url, data: body, headers, timeout: 120000 })
  return res.data
}

async function fetchRecentRecords(userId, since) {
  const { data, error } = await supabaseAdmin
    .from('ai_call_record')
    .select('task_type, model, prompt_tokens, completion_tokens, total_tokens, cost, success, create_time')
    .eq('user_id', userId)
    .gte('create_time', since)
    .order('create_time', { ascending: false })
  if (error) throw error
  return data || []
}

function validateRecord(rec) {
  const issues = []
  if (!rec.model) issues.push('model 为空')
  if (!rec.total_tokens || rec.total_tokens <= 0) issues.push('total_tokens <= 0')
  if (rec.success && (!rec.cost || rec.cost <= 0)) issues.push('cost <= 0')
  return issues
}

async function main() {
  console.log('[verify] API base:', BASE)
  const since = new Date().toISOString()
  const { token, resume, userId } = await getTestContext()
  console.log('[verify] 测试用户:', userId, '简历 id:', resume.id)

  for (const ep of AI_ENDPOINTS) {
    process.stdout.write(`[verify] 调用 ${ep.taskType} ... `)
    try {
      await callAi(token, ep, resume)
      console.log('OK')
    } catch (e) {
      console.log('FAIL:', e.response?.data?.detail || e.message)
    }
  }

  await new Promise((r) => setTimeout(r, 2000))
  const records = await fetchRecentRecords(userId, since)
  console.log('\n[verify] 新增 AI 调用记录:', records.length)
  let allOk = records.length > 0
  for (const rec of records) {
    const issues = validateRecord(rec)
    const status = issues.length ? '✗' : '✓'
    console.log(`  ${status} ${rec.task_type} | model=${rec.model} | tokens=${rec.total_tokens} | cost=¥${rec.cost}`)
    if (issues.length) {
      allOk = false
      console.log('    问题:', issues.join(', '))
    }
  }

  if (!allOk) {
    console.error('\n[verify] 验证未完全通过')
    process.exit(1)
  }
  console.log('\n[verify] ✓ 所有记录均含 model、token 与费用')
}

main().catch((e) => {
  console.error('[verify] 失败:', e.message)
  process.exit(1)
})
