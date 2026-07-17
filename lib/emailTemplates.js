/**
 * 验证码邮件模板
 * 风格与前端 AI简历 一致：简洁、专业、翠绿主色
 */

const BRAND = 'AI简历'
const EXPIRE_MINUTES = 10

/** 各场景邮件配置 */
const TEMPLATE_META = {
  login: {
    subject: '登录验证码',
    title: '邮箱登录验证',
    desc: '您正在使用邮箱验证码登录 AI简历，请使用以下验证码完成登录。',
    action: '登录',
  },
  register: {
    subject: '注册验证码',
    title: '欢迎注册',
    desc: '感谢您注册 AI简历！请使用以下验证码完成邮箱验证并创建账号。',
    action: '注册',
  },
  reset: {
    subject: '密码重置验证码',
    title: '重置密码',
    desc: '您正在申请重置 AI简历账号密码，请使用以下验证码完成验证。',
    action: '重置密码',
  },
}

/**
 * 纯文本邮件正文
 * @param {string} code
 * @param {string} type login | register | reset
 */
function buildTextBody(code, type = 'login') {
  const meta = TEMPLATE_META[type] || TEMPLATE_META.login
  return [
    `【${BRAND}】${meta.title}`,
    '',
    meta.desc,
    '',
    `您的${meta.subject}是：${code}`,
    `${EXPIRE_MINUTES} 分钟内有效，请勿泄露。`,
    '',
    `如非本人操作，请忽略此邮件，您的账号仍然安全。`,
    '',
    `— ${BRAND} 团队`,
  ].join('\n')
}

/**
 * HTML 邮件正文（翠绿主题，兼容主流邮件客户端）
 * @param {string} code
 * @param {string} type login | register | reset
 */
function buildHtmlBody(code, type = 'login') {
  const meta = TEMPLATE_META[type] || TEMPLATE_META.login
  const year = new Date().getFullYear()

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>【${BRAND}】${meta.subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
          <!-- 顶部品牌条 -->
          <tr>
            <td style="background:linear-gradient(135deg,#059669 0%,#10b981 100%);padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:600;color:#ffffff;letter-spacing:1px;">${BRAND}</p>
              <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.85);">${meta.title}</p>
            </td>
          </tr>
          <!-- 正文 -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">${meta.desc}</p>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">您的${meta.subject}</p>
              <!-- 验证码 -->
              <div style="margin:16px 0 24px;padding:20px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;text-align:center;">
                <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#059669;">${code}</span>
              </div>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
                <strong style="color:#374151;">${EXPIRE_MINUTES} 分钟内有效</strong>，请勿将验证码告知他人。
              </p>
              <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">
                如非本人操作，请忽略此邮件，您的账号仍然安全。
              </p>
            </td>
          </tr>
          <!-- 页脚 -->
          <tr>
            <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #f3f4f6;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">此邮件由系统自动发送，请勿直接回复</p>
              <p style="margin:6px 0 0;font-size:12px;color:#d1d5db;">© ${year} ${BRAND}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * 将相对路径转为邮件可用的绝对 URL
 * @param {string} baseUrl 公网前缀
 * @param {string} path 相对或绝对路径
 */
function resolveAbsoluteUrl(baseUrl, path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  const base = String(baseUrl || '').replace(/\/$/, '')
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalized}`
}

/**
 * 替换模板占位符
 * @param {string} template
 * @param {Record<string, string|number>} vars
 */
function renderTemplate(template, vars = {}) {
  let result = String(template || '')
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, String(value ?? ''))
  }
  return result
}

/**
 * 管理员通知邮件默认 HTML（用户提交充值凭证）
 * @param {Object} vars 占位符变量
 */
function buildRechargeAdminNotifyHtml(vars = {}) {
  const year = new Date().getFullYear()
  const proofImageUrl = vars.proof_image_url || ''
  const proofBlock = proofImageUrl
    ? `<div style="margin:20px 0;text-align:center;">
        <img src="${proofImageUrl}" alt="支付凭证" style="max-width:100%;border-radius:12px;border:1px solid #e5e7eb;" />
      </div>`
    : '<p style="margin:16px 0;font-size:13px;color:#9ca3af;">未上传凭证图片</p>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>【${BRAND}】用户提交了充值凭证</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#059669 0%,#10b981 100%);padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:600;color:#ffffff;letter-spacing:1px;">${BRAND}</p>
              <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.85);">充值凭证待审核</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">用户 <strong>{{user_nickname}}</strong>（{{user_email}}）已提交充值凭证，请尽快登录管理后台审核入账。</p>
              <div style="margin:16px 0;padding:16px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;">
                <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">实付金额</p>
                <p style="margin:0;font-size:28px;font-weight:700;color:#059669;">¥{{paid_amount}}</p>
              </div>
              ${proofBlock}
              <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">提交时间：{{create_time}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #f3f4f6;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">此邮件由系统自动发送，请勿直接回复</p>
              <p style="margin:6px 0 0;font-size:12px;color:#d1d5db;">© ${year} ${BRAND}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * 用户确认邮件默认 HTML（管理员审核入账后）
 * @param {Object} vars 占位符变量
 */
function buildRechargeUserConfirmHtml(vars = {}) {
  const year = new Date().getFullYear()

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>【${BRAND}】充值已到账</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#059669 0%,#10b981 100%);padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:600;color:#ffffff;letter-spacing:1px;">${BRAND}</p>
              <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.85);">充值已到账</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">您好，{{user_nickname}}！您的充值已由管理员 <strong>{{admin_nickname}}</strong> 确认并入账。</p>
              <div style="margin:16px 0;padding:16px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;">
                <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">实付金额 / 到账额度</p>
                <p style="margin:0;font-size:28px;font-weight:700;color:#059669;">¥{{paid_amount}} → ¥{{grant_amount}}</p>
              </div>
              <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">确认时间：{{create_time}}</p>
              <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#9ca3af;">额度已计入您的账户，可前往用户中心查看余额与流水。</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #f3f4f6;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">此邮件由系统自动发送，请勿直接回复</p>
              <p style="margin:6px 0 0;font-size:12px;color:#d1d5db;">© ${year} ${BRAND}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

module.exports = {
  BRAND,
  EXPIRE_MINUTES,
  TEMPLATE_META,
  buildTextBody,
  buildHtmlBody,
  buildRechargeAdminNotifyHtml,
  buildRechargeUserConfirmHtml,
  renderTemplate,
  resolveAbsoluteUrl,
}
