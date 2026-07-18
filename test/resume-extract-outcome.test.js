const test = require('node:test')
const assert = require('node:assert/strict')

const { extractJsonSafe } = require('../utils/extractJson')
const { hasResumeContent } = require('../services/ai/resume-content')

/**
 * 模拟识别服务在拿到模型原文后的分支决策，不发起真实 AI 请求。
 * 与 extractResumeFromTextStream 保持同一套判定顺序。
 */
function decideExtractOutcome(aiContent) {
  const { ok, data: parsed } = extractJsonSafe(aiContent)
  if (!ok) {
    return { type: 'parse_error', code: 'RESUME_JSON_PARSE_FAILED' }
  }
  if (!parsed || Object.keys(parsed).length === 0) {
    return { type: 'empty_resume' }
  }
  if (!hasResumeContent(parsed)) {
    return { type: 'empty_resume' }
  }
  return { type: 'success', resume: parsed }
}

test('JSON 解析失败应映射为 RESUME_JSON_PARSE_FAILED', () => {
  const outcome = decideExtractOutcome('```json\n{name:"坏掉的"\n```')
  assert.equal(outcome.type, 'parse_error')
  assert.equal(outcome.code, 'RESUME_JSON_PARSE_FAILED')
})

test('合法但无有效字段应映射为空简历业务结果', () => {
  assert.equal(decideExtractOutcome('{}').type, 'empty_resume')
  assert.equal(
    decideExtractOutcome('{"name":"","projects":[],"skills":[]}').type,
    'empty_resume',
  )
})

test('含裸换行的合法简历 JSON 应成功识别而非解析失败', () => {
  const raw = '```json\n{"name":"测试","summary":"第一行\n第二行","skills":["Vue"]}\n```'
  const outcome = decideExtractOutcome(raw)
  assert.equal(outcome.type, 'success')
  assert.equal(outcome.resume.name, '测试')
  assert.equal(outcome.resume.summary, '第一行\n第二行')
})

test('文本过短阈值与服务层一致', () => {
  const tooShort = '姓名：张'
  const meaningfulChars = tooShort.replace(/\s+/g, '')
  assert.ok(meaningfulChars.length < 30)
  const enough = '姓名：张三\n电话：13800000000\n求职意向：前端工程师\n教育：某某大学'
  assert.ok(enough.replace(/\s+/g, '').length >= 30)
})
