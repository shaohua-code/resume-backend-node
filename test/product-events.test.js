const test = require('node:test')
const assert = require('node:assert/strict')
const { validateEvent } = require('../services/productEvents/productEvents.service')

const base = {
  event_id: '73a3f7e4-a75f-4bc8-81dd-66568af7bd83',
  session_id: '9a4b7fa1-cc5a-4c14-93f6-41c997cfbca7',
  event_name: 'home_primary_cta_clicked',
  properties: { visitor_state: 'anonymous', cta_id: 'start_resume' },
}

test('只接受白名单事件及枚举属性', () => {
  assert.equal(validateEvent(base).event_name, base.event_name)
  assert.equal(validateEvent({ ...base, properties: { ...base.properties, resume_text: 'private' } }), null)
  assert.equal(validateEvent({ ...base, event_name: 'unknown_event' }), null)
  assert.equal(validateEvent({ ...base, properties: { cta_id: 'arbitrary' } }), null)
})

test('拒绝无效会话标识和过期事件时间', () => {
  assert.equal(validateEvent({ ...base, session_id: 'bad-id' }), null)
  assert.equal(validateEvent({ ...base, occurred_at: 'not-a-date' }), null)
  assert.equal(validateEvent({ ...base, occurred_at: '2020-01-01T00:00:00.000Z' }), null)
})
