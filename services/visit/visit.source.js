/**
 * 访客来源归一化
 * 优先认分享链接 from/utm_source，其次用 referrer 主机映射，否则记为直接访问
 */

const PLATFORM_KEYS = new Set([
  'wechat',
  'xiaohongshu',
  'douyin',
  'weibo',
  'qq',
  'bilibili',
  'zhihu',
  'other',
])

const REFERRER_HOST_MAP = [
  { match: /(^|\.)weixin\.qq\.com$/i, key: 'wechat' },
  { match: /(^|\.)wx\.qq\.com$/i, key: 'wechat' },
  { match: /(^|\.)xiaohongshu\.com$/i, key: 'xiaohongshu' },
  { match: /(^|\.)xhslink\.com$/i, key: 'xiaohongshu' },
  { match: /(^|\.)douyin\.com$/i, key: 'douyin' },
  { match: /(^|\.)iesdouyin\.com$/i, key: 'douyin' },
  { match: /(^|\.)weibo\.com$/i, key: 'weibo' },
  { match: /(^|\.)weibo\.cn$/i, key: 'weibo' },
  { match: /(^|\.)bilibili\.com$/i, key: 'bilibili' },
  { match: /(^|\.)b23\.tv$/i, key: 'bilibili' },
  { match: /(^|\.)zhihu\.com$/i, key: 'zhihu' },
]

function normalizePlatformKey(raw) {
  const key = String(raw || '').trim().toLowerCase()
  return PLATFORM_KEYS.has(key) ? key : ''
}

function mapReferrerHost(hostname) {
  const host = String(hostname || '').replace(/^www\./i, '').toLowerCase()
  if (!host) return ''
  const hit = REFERRER_HOST_MAP.find((item) => item.match.test(host))
  if (hit) return hit.key
  if (host === 'qq.com' || host.endsWith('.qq.com')) return 'qq'
  return ''
}

/**
 * 把前端上报的 visit_source 压成稳定存储值
 * @param {string} raw 前端解析结果或原始 referrer
 * @returns {string} platform:key 或 direct
 */
function normalizeVisitSource(raw) {
  const source = String(raw || '').trim()
  if (!source) return 'direct'

  const prefixed = source.match(/^(?:platform|utm):([a-z0-9_-]+)$/i)
  if (prefixed) {
    const key = normalizePlatformKey(prefixed[1])
    return key ? `platform:${key}` : 'direct'
  }

  const bareKey = normalizePlatformKey(source)
  if (bareKey) return `platform:${bareKey}`

  try {
    if (/^https?:\/\//i.test(source)) {
      const host = new URL(source).hostname
      const mapped = mapReferrerHost(host)
      return mapped ? `platform:${mapped}` : 'direct'
    }
  } catch {
    // 非法 URL 视为无法识别来源
  }

  return 'direct'
}

module.exports = {
  PLATFORM_KEYS,
  normalizePlatformKey,
  normalizeVisitSource,
}
