/**
 * 浏览器扩展入口。
 * 版本与固定安装包保持公开；账号、收藏、分析和回填接口都按各自路由执行鉴权。
 */
const express = require('express')
const fs = require('fs')
const path = require('path')
const { success } = require('../utils/response')
const crypto = require('crypto')
const db = require('../lib/db')
const { signAccessToken } = require('../lib/jwt')
const { authRequired, emailBindingRequired } = require('../middlewares/auth')
const extensionController = require('../controllers/extension.controller')
const { settings } = require('../config')

const router = express.Router()
const EXTENSION_VERSION = '2.0.0'
const EXTENSION_PACKAGE_NAME = `ai-resume-extension-v${EXTENSION_VERSION}.zip`
const INVALID_JOB_TITLE = /^(?:微信扫码分享|职位描述|岗位描述|职位详情|岗位详情|公司信息|招聘官|收藏|立即沟通|立即投递)$/i

router.get('/version', (req, res) => success(res, {
  version: EXTENSION_VERSION,
  minimum_version: EXTENSION_VERSION,
  download_path: '/api/extension/download',
  release_notes: '岗位识别、收藏同步、取消收藏与网页端重新分析',
}))

// 官网下载始终读取后端发布目录中的当前版本包，避免本地与线上地址分叉。
router.get('/download', (req, res) => {
  const filePath = path.join(settings.EXTENSION_RELEASE_DIR, EXTENSION_PACKAGE_NAME)
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ detail: '扩展安装包尚未发布，请稍后再试' })
  }
  return res.download(filePath, EXTENSION_PACKAGE_NAME)
})

// 一次性授权码原子消费后才签发新的扩展会话，扩展从不接触网页端 refresh token。
router.post('/auth/exchange', async (req, res) => {
  const code = String(req.body?.code || '').trim()
  if (!code) return res.status(400).json({ detail: '授权码不能为空' })
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  try {
    const { rows: codes } = await db.query(
      `DELETE FROM public.extension_auth_code
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [codeHash],
    )
    if (!codes.length) return res.status(401).json({ detail: '授权已失效，请重新打开扩展' })
    const { rows: users } = await db.query('SELECT id, account, email, email_verified, session_version FROM public.users WHERE id = $1', [codes[0].user_id])
    if (!users.length) return res.status(401).json({ detail: '账号不存在' })
    return success(res, { access_token: signAccessToken(users[0]) })
  } catch (error) { return res.status(500).json({ detail: '扩展授权暂时不可用' }) }
})

router.get('/bootstrap', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, title, update_time FROM public.resume WHERE user_id = $1 ORDER BY update_time DESC',
      [req.user.id],
    )
    return success(res, { resumes: rows, default_resume_id: rows[0]?.id || '' })
  } catch (error) { return res.status(500).json({ detail: '加载简历失败' }) }
})

router.get('/resumes/:resumeId/autofill', authRequired, async (req, res) => {
  const resumeId = Number(req.params.resumeId)
  if (!Number.isSafeInteger(resumeId) || resumeId <= 0) return res.status(400).json({ detail: 'Invalid resume id' })
  try {
    const { rows } = await db.query(
      'SELECT resume_json FROM public.resume WHERE id = $1 AND user_id = $2 LIMIT 1',
      [resumeId, req.user.id],
    )
    if (!rows.length) return res.status(404).json({ detail: 'Resume not found' })
    let resume = {}
    try { resume = JSON.parse(rows[0].resume_json || '{}') } catch { return res.status(422).json({ detail: 'Resume data is invalid' }) }
    return success(res, { resume })
  } catch (error) {
    return res.status(500).json({ detail: 'Unable to load resume for autofill' })
  }
})

router.get('/jobs', authRequired, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, source_url, source_platform, source_original, title, company, location, address, salary, skills,
              resume_id, match_result, status, create_time, update_time
       FROM public.extension_saved_job
       WHERE user_id = $1
         AND title !~* '^(微信扫码分享|职位描述|岗位描述|职位详情|岗位详情|公司信息|招聘官|收藏|立即沟通|立即投递)$'
       ORDER BY update_time DESC LIMIT 100`,
      [req.user.id],
    )
    return success(res, { jobs: rows })
  } catch (error) {
    return res.status(500).json({ detail: 'Unable to load saved jobs' })
  }
})

router.get('/jobs/:jobId', authRequired, async (req, res) => {
  const jobId = Number(req.params.jobId)
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return res.status(400).json({ detail: 'Invalid job id' })
  try {
    const { rows } = await db.query(
      `SELECT id, source_url, source_platform, source_original, title, company, location, address, salary, skills,
              jd_text, resume_id, match_result, status, create_time, update_time
       FROM public.extension_saved_job WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, req.user.id],
    )
    if (!rows.length) return res.status(404).json({ detail: 'Saved job not found' })
    return success(res, { job: rows[0] })
  } catch (error) {
    return res.status(500).json({ detail: 'Unable to load saved job' })
  }
})

// 网页端重新分析复用 jd_match 的邮箱门禁与 Token 计费，不在扩展模块复制模型配置。
router.post('/jobs/:jobId/analyze', authRequired, emailBindingRequired, extensionController.analyzeSavedJob)

// 取消收藏只删除当前用户的数据，不触碰招聘网站自身的收藏状态。
router.delete('/jobs/:jobId', authRequired, extensionController.removeSavedJob)

router.post('/jobs', authRequired, async (req, res) => {
  const sourceUrl = cleanHttpUrl(req.body?.source_url)
  const title = cleanText(req.body?.title, 120)
  const jdText = cleanText(req.body?.jd_text, 24000)
  if (!sourceUrl || !title || INVALID_JOB_TITLE.test(title) || jdText.length < 40) {
    return res.status(400).json({ detail: 'Job information is incomplete' })
  }
  const resumeId = Number.isSafeInteger(Number(req.body?.resume_id)) ? Number(req.body.resume_id) : null
  const company = cleanText(req.body?.company, 200)
  const location = cleanText(req.body?.location, 160)
  const address = cleanText(req.body?.address, 300)
  const salary = cleanText(req.body?.salary, 80)
  const skills = normalizeSkills(req.body?.skills)
  const sourcePlatform = cleanText(req.body?.source_platform, 80)
  const sourceOriginal = cleanText(req.body?.source_original, 120)
  const status = ['saved', 'ready', 'applied', 'archived'].includes(req.body?.status) ? req.body.status : 'saved'
  // 清洗后的完整 URL 是岗位身份；查询参数可能包含岗位 ID，禁止只按 pathname 去重。
  const sourceKey = crypto.createHash('sha256').update(sourceUrl).digest('hex')
  try {
    const { rows } = await db.query(
      `INSERT INTO public.extension_saved_job
         (user_id, source_key, source_url, title, company, location, address, salary, skills,
          source_platform, source_original, jd_text, resume_id, match_result, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15)
       ON CONFLICT (user_id, source_key) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         title = EXCLUDED.title, company = EXCLUDED.company, location = EXCLUDED.location,
         address = EXCLUDED.address, salary = EXCLUDED.salary, skills = EXCLUDED.skills,
         source_platform = EXCLUDED.source_platform, source_original = EXCLUDED.source_original,
         jd_text = EXCLUDED.jd_text, resume_id = EXCLUDED.resume_id,
         match_result = EXCLUDED.match_result, status = EXCLUDED.status, update_time = now()
       RETURNING id, source_url, source_platform, title, company, location, address, salary, skills, status, update_time`,
      [
        req.user.id,
        sourceKey,
        sourceUrl,
        title,
        company,
        location,
        address,
        salary,
        JSON.stringify(skills),
        sourcePlatform,
        sourceOriginal,
        jdText,
        resumeId,
        JSON.stringify(req.body?.match_result || {}),
        status,
      ],
    )
    return success(res, { job: rows[0] })
  } catch (error) {
    return res.status(500).json({ detail: 'Unable to save job' })
  }
})

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength)
}

function cleanHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|from|fromSource|source|refer|ref|spm|ka|sid|track|trackingId|securityId|s|t|req)$/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

// 扩展只提交页面明确给出的技能标签；后端不从整段 JD 猜测或补造技能。
function normalizeSkills(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[，,、;；|｜/\n]/)
  return [...new Set(source
    .map((item) => cleanText(typeof item === 'object' ? item?.name : item, 80))
    .filter(Boolean))]
    .slice(0, 40)
}

module.exports = router
