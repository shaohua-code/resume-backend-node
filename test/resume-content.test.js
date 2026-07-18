const test = require('node:test');
const assert = require('node:assert/strict');

const { hasResumeContent, extractTargetPosition } = require('../services/ai/resume-content');

// 覆盖识别结果的扩展字段边界，避免只按传统姓名/经历字段误判为空。
test('只有目标岗位或扩展字段时仍视为有效识别结果', () => {
  assert.equal(hasResumeContent({ target_position: '产品经理' }), true);
  assert.equal(hasResumeContent({ height: '175cm' }), true);
  assert.equal(hasResumeContent({ custom_fields: [{ label: '作品集', value: 'example.com' }] }), true);
});

// 空占位对象不能触发成功完成事件，否则前端会误报“识别完成”。
test('空字符串、空数组和空占位对象不算有效识别结果', () => {
  assert.equal(hasResumeContent({}), false);
  assert.equal(hasResumeContent({ name: '  ', projects: [], skills: [] }), false);
  assert.equal(hasResumeContent({ projects: [{ name: '', description: '' }] }), false);
  assert.equal(hasResumeContent({ custom_fields: [{ label: '', value: '' }] }), false);
});

// 当前职位是经历事实，不等同于求职意向；只有明确意向字段才可进入目标岗位。
test('纯识别不会把通用职位字段推断为目标岗位', () => {
  assert.equal(extractTargetPosition({ position: 'Java工程师' }, { strict: true }), '');
  assert.equal(extractTargetPosition({ job_title: '产品经理' }, { strict: true }), '');
  assert.equal(extractTargetPosition({ target_position: '测试工程师' }, { strict: true }), '测试工程师');
  assert.equal(extractTargetPosition({ 求职岗位: '运营专员' }, { strict: true }), '运营专员');
});
