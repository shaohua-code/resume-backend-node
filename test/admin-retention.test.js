const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeDays } = require('../services/admin/admin.retention.service')

test('留存面板仅接受定义好的统计周期', () => {
  assert.equal(normalizeDays(7), 7)
  assert.equal(normalizeDays('30'), 30)
  assert.equal(normalizeDays(90), 90)
  assert.throws(() => normalizeDays(14), { statusCode: 400 })
})
