/**
 * 用户反馈路由
 * 登录用户提交富文本反馈，服务端转换为 Markdown 存储
 */

const express = require('express');
const TurndownService = require('turndown');
const { supabaseAdmin } = require('../supabaseClient');
const { authRequired } = require('../middlewares/auth');

const router = express.Router();
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

router.use(authRequired);

function htmlToMarkdown(html) {
  const raw = String(html || '').trim();
  if (!raw) return '';
  return turndown.turndown(raw);
}

function stripHtmlText(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/**
 * POST /api/feedback
 * body: { content_html }
 */
router.post('/', async (req, res) => {
  try {
    const contentHtml = String(req.body?.content_html || '').trim();
    if (!stripHtmlText(contentHtml)) {
      return res.status(400).json({ detail: '反馈内容不能为空' });
    }

    const contentMd = htmlToMarkdown(contentHtml);
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('user_feedback')
      .insert({
        user_id: req.user.id,
        content_html: contentHtml,
        content_md: contentMd,
        create_time: now,
      })
      .select('id, create_time')
      .single();

    if (error) {
      return res.status(500).json({ detail: `提交失败：${error.message}` });
    }

    return res.json({ success: true, data, message: '反馈提交成功' });
  } catch (e) {
    return res.status(500).json({ detail: e.message || '提交失败' });
  }
});

module.exports = router;
