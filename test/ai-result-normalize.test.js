/**
 * AI 评分与岗位分析归一化测试。
 * 覆盖线上已出现的旧版 score/reason 输出及常见岗位字段别名，防止界面再次回落为全 0 或空结果。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeScoreResult,
  normalizeJdMatchResult,
  createScoreVisibleChunkHandler,
} = require('../services/ai/ai.resultNormalize');

test('旧版 score/reason 会生成总分一致的五维评分', () => {
  const result = normalizeScoreResult({ score: 75, reason: '结构完整，但经历证据仍可加强。' });

  assert.equal(result.total, 75);
  assert.equal(
    result.content_completeness
      + result.skill_match
      + result.project_quality
      + result.resume_structure
      + result.format_quality,
    75,
  );
  assert.equal(result.summary, '结构完整，但经历证据仍可加强。');
  assert.match(result.fallback_note, /按既定满分权重折算/);
});

test('完整维度评分会限制范围并按维度重新计算总分', () => {
  const result = normalizeScoreResult({
    content_completeness: 18,
    skill_match: 17,
    project_quality: 25,
    resume_structure: 13,
    format_quality: 14,
    total: 2,
  });

  assert.equal(result.total, 87);
  assert.equal(result.project_quality, 25);
  assert.equal(result.fallback_note, '');
});

test('岗位分析兼容别名和字符串列表，简短岗位名称也有可见结果', () => {
  const result = normalizeJdMatchResult({
    score: '68',
    strengths: 'Node.js 项目经验、接口设计经验',
    skill_gaps: '简历未体现：消息队列\n3年以上经验',
    advice: '补充接口性能数据；说明部署职责',
  }, '后端');

  assert.equal(result.match_score, 68);
  assert.deepEqual(result.match_advantages, ['Node.js 项目经验', '接口设计经验']);
  assert.deepEqual(result.keywords, ['后端']);
  assert.deepEqual(result.missing_skills, ['简历未体现：消息队列', '3年以上经验']);
  assert.equal(result.suggestions.length, 2);
});

test('评分流隐藏内部机器 JSON 并保留完整中文报告', () => {
  const visible = [];
  const handler = createScoreVisibleChunkHandler((chunk) => visible.push(chunk));
  handler('总分：75/100\n内容完整度：15/20\n<SCORE_');
  handler('JSON>{"score":75}</SCORE_JSON>');
  handler.flush();

  assert.equal(visible.join(''), '总分：75/100\n内容完整度：15/20\n');
});

test('旧提示词直接输出纯 JSON 时不把机器字段展示给用户', () => {
  const visible = [];
  const handler = createScoreVisibleChunkHandler((chunk) => visible.push(chunk));
  handler('{"score":75,');
  handler('"reason":"结构完整"}');
  handler.flush();

  assert.equal(visible.join(''), '');
});
