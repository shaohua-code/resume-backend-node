const test = require('node:test')
const assert = require('node:assert/strict')

const { extractJson, extractJsonSafe, stripMarkdownFence } = require('../utils/extractJson')

test('合法 JSON 可直接解析', () => {
  const data = extractJson('{"name":"张三","skills":["Vue"]}')
  assert.equal(data.name, '张三')
  assert.deepEqual(data.skills, ['Vue'])
})

test('可剥离 markdown 代码块', () => {
  const raw = '```json\n{"name":"李四","phone":"13800000000"}\n```'
  assert.equal(stripMarkdownFence(raw), '{"name":"李四","phone":"13800000000"}')
  const data = extractJson(raw)
  assert.equal(data.name, '李四')
  assert.equal(data.phone, '13800000000')
})

test('可修复对象尾逗号', () => {
  const data = extractJson('{"name":"王五","email":"a@b.com",}')
  assert.equal(data.name, '王五')
  assert.equal(data.email, 'a@b.com')
})

test('可修复字符串内裸换行', () => {
  const raw = '{\n  "name": "赵六",\n  "summary": "第一行\n第二行"\n}'
  const result = extractJsonSafe(raw)
  assert.equal(result.ok, true)
  assert.equal(result.data.name, '赵六')
  assert.equal(result.data.summary, '第一行\n第二行')
})

test('extractJsonSafe 可区分解析失败与合法空对象', () => {
  const emptyOk = extractJsonSafe('{}')
  assert.equal(emptyOk.ok, true)
  assert.deepEqual(emptyOk.data, {})

  const broken = extractJsonSafe('这不是 JSON { name: }')
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.data, {})
  assert.equal(broken.reason, 'parse_error')

  // 兼容旧 API：失败仍返回空对象，不抛异常
  assert.deepEqual(extractJson('这不是 JSON { name: }'), {})
})

test('前后夹杂说明文字时仍能提取对象', () => {
  const raw = '以下是结果：\n```json\n{"name":"钱七","target_position":"前端工程师"}\n```\n结束'
  const data = extractJson(raw)
  assert.equal(data.name, '钱七')
  assert.equal(data.target_position, '前端工程师')
})
