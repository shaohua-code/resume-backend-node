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
  // 生产环境必须配置 SMTP，开发环境使用 debug 级别（避免泄露到生产日志）
  console.warn(`[email] ⚠️ SMTP 未配置，验证码将打印到控制台（仅限开发环境）`)
  console.debug(`[email] 验证码已发送至 ${email} (${type})`)
  // 开发环境可临时查看：console.debug(`[email] 验证码: ${code}`)
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

/**
 * 发送自定义模板邮件（充值通知等）
 * @param {string} to 收件人
 * @param {string} subject 主题
 * @param {string} text 纯文本正文
 * @param {string} html HTML 正文
 */
async function sendTemplateEmail(to, subject, text, html) {
  if (!settings.SMTP_HOST || !settings.SMTP_USER) {
    console.log(`[email] SMTP 未配置，模板邮件 → ${to}: ${subject}`)
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
    to,
    subject,
    text,
    html,
  })
  return true
}

module.exports = { sendOtpEmail, sendTemplateEmail }
