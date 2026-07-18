const test = require('node:test');
const assert = require('node:assert/strict');

const { RESUME_EXTRACT_PROMPT } = require('../services/ai/ai.prompts');
const {
  AI_TASK,
  AI_TASK_CATALOG,
  AI_MODEL_TYPE,
} = require('../services/ai/ai.model');

// Prompt 文本是“只识别不优化”的后端最后防线，关键禁令必须保持可回归。
test('纯识别 Prompt 明确禁止生成、润色、补写和岗位推断', () => {
  assert.match(RESUME_EXTRACT_PROMPT, /信息抽取任务/);
  assert.match(RESUME_EXTRACT_PROMPT, /不得润色、优化、总结、改写/);
  assert.match(RESUME_EXTRACT_PROMPT, /不得生成新的summary、skills、target_position/);
  assert.match(RESUME_EXTRACT_PROMPT, /没有明确岗位时输出空字符串/);
  assert.match(RESUME_EXTRACT_PROMPT, /不得输出optimization_notes/);
});

// 独立任务保证模型配置、调用审计和钱包用量不再显示为生成或 PDF 优化。
test('resume_extract 注册为独立文本模型任务', () => {
  assert.equal(AI_TASK.RESUME_EXTRACT, 'resume_extract');
  const task = AI_TASK_CATALOG.find((item) => item.task_type === AI_TASK.RESUME_EXTRACT);
  assert.deepEqual(task, {
    task_type: 'resume_extract',
    name: '简历信息识别',
    required_model_type: AI_MODEL_TYPE.TEXT,
  });
});
