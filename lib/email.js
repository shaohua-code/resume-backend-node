/**
 * SMTP 验证码邮件发送
 */

const { settings } = require('../config')
const { BRAND, buildTextBody, buildHtmlBody } = require('./emailTemplates')

/**
 * 发送验证码邮件
 * @param {string} email 收件人
 * @param {string} code 6 位验证码
 * @param {string} type login | register | reset
 */
async function sendOtpEmail(email, code, type = 'login') {
  const subjectMap = {
    login: '登录验证码',
    register: '注册验证码',
    reset: '密码重置验证码',
  }
  const subject = subjectMap[type] || '验证码'
  const text = buildTextBody(code, type)
  const html = buildHtmlBody(code, type)

  if (!settings.SMTP_HOST || !settings.SMTP_USER) {
    console.log(`[email] SMTP 未配置，验证码 → ${email}: ${code} (${type})`)
    console.log(text)
    return true
  }

  const nodemailer = require('nodemailer')
  const transporter = nodemailer.createTransport({
    host: settings.SMTP_HOST,
    port: settings.SMTP_PORT,
    secure: settings.SMTP_SECURE,
    auth: { user: settings.SMTP_USER, pass: settings.SMTP_PASS },
  })

  await transporter.sendMail({
    from: settings.SMTP_FROM || settings.SMTP_USER,
    to: email,
    subject: `【${BRAND}】${subject}`,
    text,
    html,
  })
  return true
}

module.exports = { sendOtpEmail }
