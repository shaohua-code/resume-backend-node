const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldFallbackToDeepseek,
  withDeepseekFallback,
} = require('../services/ai/ai.fallback');

test('优化任务首次失败后仅调用一次 DeepSeek 兜底', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const result = await withDeepseekFallback(
    'summary_optimize',
    async () => {
      primaryCalls += 1;
      throw new Error('primary failed');
    },
    async () => {
      fallbackCalls += 1;
      return 'fallback result';
    },
  );

  assert.equal(result, 'fallback result');
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test('主调用成功时不调用 DeepSeek 兜底', async () => {
  let fallbackCalls = 0;
  const result = await withDeepseekFallback(
    'pdf_optimize',
    async () => 'primary result',
    async () => {
      fallbackCalls += 1;
      return 'fallback result';
    },
  );

  assert.equal(result, 'primary result');
  assert.equal(fallbackCalls, 0);
});

// 纯识别可以更换一次模型，但不能把两份流式结果拼接到同一表单。
test('简历纯识别在首个流片段前失败时允许单次兜底', async () => {
  let fallbackCalls = 0;
  const result = await withDeepseekFallback(
    'resume_extract',
    async () => { throw new Error('primary failed'); },
    async () => {
      fallbackCalls += 1;
      return 'fallback result';
    },
  );

  assert.equal(result, 'fallback result');
  assert.equal(fallbackCalls, 1);
  assert.equal(shouldFallbackToDeepseek('resume_extract'), true);
});

test('非优化任务失败时不触发兜底', async () => {
  const primaryError = new Error('generate failed');
  let fallbackCalls = 0;

  await assert.rejects(
    withDeepseekFallback(
      'resume_generate',
      async () => { throw primaryError; },
      async () => {
        fallbackCalls += 1;
        return 'fallback result';
      },
    ),
    (error) => error === primaryError,
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(shouldFallbackToDeepseek('resume_generate'), false);
});

test('DeepSeek 兜底也失败时保留首次错误语义且不重复重试', async () => {
  const primaryError = Object.assign(new Error('primary failed'), {
    code: 'PRIMARY_ERROR',
    statusCode: 502,
  });
  const fallbackError = new Error('fallback failed');
  let fallbackCalls = 0;

  await assert.rejects(
    withDeepseekFallback(
      'project_optimize',
      async () => { throw primaryError; },
      async () => {
        fallbackCalls += 1;
        throw fallbackError;
      },
    ),
    (error) => (
      error === primaryError
      && error.code === 'PRIMARY_ERROR'
      && error.statusCode === 502
      && error.fallbackError === fallbackError
    ),
  );
  assert.equal(fallbackCalls, 1);
});

test('调用方判定流内容已输出时不执行兜底，避免拼接两份结果', async () => {
  const primaryError = new Error('stream interrupted');
  let fallbackCalls = 0;

  await assert.rejects(
    withDeepseekFallback(
      'skills_optimize',
      async () => { throw primaryError; },
      async () => {
        fallbackCalls += 1;
        return 'fallback result';
      },
      { canFallback: () => false },
    ),
    (error) => error === primaryError,
  );
  assert.equal(fallbackCalls, 0);
});
