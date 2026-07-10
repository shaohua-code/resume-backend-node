/**
 * 访客记录业务服务
 */

const UAParser = require('ua-parser-js')
const geoip = require('geoip-lite')
const visitRepo = require('../../repositories/visit.repository')
const userRepo = require('../../repositories/user.repository')
const { getUserByToken } = require('../auth/auth.service')

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || ''
}

function resolveGeo(ip) {
  const cleanIp = String(ip || '').replace(/^::ffff:/, '')
  if (!cleanIp || cleanIp === '127.0.0.1' || cleanIp === '::1') {
    return { province: '', city: '' }
  }
  const geo = geoip.lookup(cleanIp)
  if (!geo) return { province: '', city: '' }
  return { province: geo.region || '', city: geo.city || '' }
}

function parseUserAgent(userAgent) {
  const parser = new UAParser(userAgent || '')
  const browser = parser.getBrowser()
  const os = parser.getOS()
  const device = parser.getDevice()
  return {
    browser: [browser.name, browser.version].filter(Boolean).join(' ') || 'Unknown',
    os: [os.name, os.version].filter(Boolean).join(' ') || 'Unknown',
    device_type: device.type || 'desktop',
    device_brand: device.vendor || '',
  }
}

function normalizeVisitSource(raw) {
  const source = String(raw || '').trim()
  if (!source) return 'direct'
  if (source.startsWith('utm:')) return source.slice(0, 200)
  try {
    if (source.startsWith('http')) {
      const host = new URL(source).hostname
      return host ? `referrer:${host}`.slice(0, 200) : 'direct'
    }
  } catch {
    // ignore
  }
  return source.slice(0, 200)
}

async function resolveEmailFromRequest(req) {
  const authorization = req.headers.authorization || ''
  if (!authorization.startsWith('Bearer ')) return ''
  const user = await getUserByToken(authorization.slice(7))
  if (!user) return ''
  const { data: profile } = await userRepo.findById(user.id)
  return profile?.email || user.email || ''
}

async function createVisit(req) {
  const ip = getClientIp(req)
  const geo = resolveGeo(ip)
  const uaInfo = parseUserAgent(req.headers['user-agent'])

  const { data, error } = await visitRepo.insertVisit({
    user_email: await resolveEmailFromRequest(req),
    ip_address: ip,
    province: geo.province,
    city: geo.city,
    browser: uaInfo.browser,
    os: uaInfo.os,
    device_type: uaInfo.device_type,
    device_brand: uaInfo.device_brand,
    visit_source: normalizeVisitSource(req.body?.visit_source),
    landing_path: String(req.body?.landing_path || '').slice(0, 500),
    duration_seconds: 0,
    visit_time: new Date().toISOString(),
  })

  if (error) {
    throw Object.assign(new Error(`记录访客失败：${error.message}`), { statusCode: 500 })
  }

  visitRepo.deleteOlderThan(visitRepo.RETENTION_DAYS).catch(() => {})
  return { id: data.id }
}

async function updateVisitDuration(id, durationSeconds) {
  const visitId = Number(id)
  const seconds = Math.max(0, Math.floor(Number(durationSeconds) || 0))
  if (!visitId) {
    throw Object.assign(new Error('无效的访客记录 ID'), { statusCode: 400 })
  }
  const { data, error } = await visitRepo.updateDuration(visitId, seconds)
  if (error || !data) {
    throw Object.assign(new Error('访客记录不存在'), { statusCode: 404 })
  }
  return { id: data.id, duration_seconds: seconds }
}

async function listVisitsForAdmin(req, from, to) {
  const { data, error, count } = await visitRepo.listVisits({
    from,
    to,
    keyword: req.query.keyword || '',
  })
  if (error) {
    throw Object.assign(new Error(`查询访客记录失败：${error.message}`), { statusCode: 500 })
  }
  return {
    total: count || 0,
    items: (data || []).map((row) => ({ ...row, visit_time: String(row.visit_time) })),
  }
}

module.exports = {
  createVisit,
  updateVisitDuration,
  listVisitsForAdmin,
}
