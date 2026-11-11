/**
 * SSE 辅助工具和重试机制测试
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { SSE_EVENT_TYPE, AI_STAGE, createSseHelper, createModelStatusCallback } = require('../utils/sseHelper');
const { isRetryableError, calculateDelay, withRetry, AI_RETRY_CONFIG } = require('../utils/retry');

// ========== SSE 辅助工具测试 ==========

test('AI_STAGE 枚举包含所有必要的阶段', () => {
  assert.equal(AI_STAGE.PREPARING, 'preparing');
  assert.equal(AI_STAGE.CONNECTING, 'connecting');
  assert.equal(AI_STAGE.ANALYZING, 'analyzing');
  assert.equal(AI_STAGE.GENERATING, 'generating');
  assert.equal(AI_STAGE.OPTIMIZING, 'optimizing');
  assert.equal(AI_STAGE.EXTRACTING, 'extracting');
  assert.equal(AI_STAGE.VALIDATING, 'validating');
  assert.equal(AI_STAGE.COMPLETED, 'completed');
});

test('SSE_EVENT_TYPE 枚举包含所有事件类型', () => {
  assert.equal(SSE_EVENT_TYPE.CONNECTING, 'connecting');
  assert.equal(SSE_EVENT_TYPE.HEARTBEAT, 'heartbeat');
  assert.equal(SSE_EVENT_TYPE.DONE, 'done');
  assert.equal(SSE_EVENT_TYPE.ERROR, 'error');
});

test('createSseHelper 正确设置响应头', () => {
  const headers = {};
  const mockRes = {
    setHeader: (key, value) => { headers[key] = value; },
    flushHeaders: () => {},
    write: () => {},
    end: () => {},
    on: () => {},
  };

  createSseHelper(mockRes, { enableHeartbeat: false });

  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(headers['Connection'], 'keep-alive');
  assert.equal(headers['X-Accel-Buffering'], 'no');
});

test('createSseHelper.sendStatus 发送带 stage 的状态事件', () => {
  const written = [];
  const mockRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data) => { written.push(data); },
    end: () => {},
    on: () => {},
  };

  const helper = createSseHelper(mockRes, { enableHeartbeat: false });
  helper.sendStatus('正在分析简历内容', 'analyzing');

  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0].replace('data: ', '').trim());
  assert.equal(parsed.status, '正在分析简历内容');
  assert.equal(parsed.stage, 'analyzing');
});

test('createSseHelper.sendStatus 无 stage 时只发送 status', () => {
  const written = [];
  const mockRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data) => { written.push(data); },
    end: () => {},
    on: () => {},
  };

  const helper = createSseHelper(mockRes, { enableHeartbeat: false });
  helper.sendStatus('处理中');

  const parsed = JSON.parse(written[0].replace('data: ', '').trim());
  assert.equal(parsed.status, '处理中');
  assert.equal(parsed.stage, undefined);
});

test('createModelStatusCallback 映射内部阶段到前端 stage', () => {
  const events = [];
  const mockHelper = {
    sendStatus: (status, stage) => { events.push({ status, stage }); },
  };

  const callback = createModelStatusCallback(mockHelper, AI_STAGE.GENERATING);

  // 测试 connecting 阶段
  callback('connecting', '正在连接模型...');
  assert.equal(events[0].stage, AI_STAGE.CONNECTING);

  // 测试 model 阶段（映射为 analyzing）
  callback('model', '模型已连接');
  assert.equal(events[1].stage, AI_STAGE.ANALYZING);

  // 测试 validating 阶段
  callback('validating', '正在校验结果');
  assert.equal(events[2].stage, AI_STAGE.VALIDATING);
});

// ========== 重试工具测试 ==========

test('isRetryableError 识别可重试的网络错误', () => {
  assert.equal(isRetryableError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isRetryableError({ code: 'ECONNABORTED' }), true);
  assert.equal(isRetryableError({ code: 'EAI_AGAIN' }), true);
});

test('isRetryableError 识别可重试的 HTTP 状态码', () => {
  assert.equal(isRetryableError({ response: { status: 429 } }), true);
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError({ response: { status: 504 } }), true);
});

test('isRetryableError 不重试业务错误', () => {
  assert.equal(isRetryableError({ code: 'INVALID_REQUEST' }), false);
  assert.equal(isRetryableError({ response: { status: 400 } }), false);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
  assert.equal(isRetryableError({ response: { status: 403 } }), false);
});

test('calculateDelay 计算指数退避延迟', () => {
  const config = { initialDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2, jitter: false };

  assert.equal(calculateDelay(1, config), 1000);  // 1000 * 2^0
  assert.equal(calculateDelay(2, config), 2000);  // 1000 * 2^1
  assert.equal(calculateDelay(3, config), 4000);  // 1000 * 2^2
  assert.equal(calculateDelay(4, config), 8000);  // 1000 * 2^3
  assert.equal(calculateDelay(5, config), 10000); // 超过 maxDelayMs，限制为 10000
});

test('withRetry 成功时直接返回结果', async () => {
  let callCount = 0;
  const result = await withRetry(async () => {
    callCount += 1;
    return 'success';
  }, { maxRetries: 3 });

  assert.equal(result, 'success');
  assert.equal(callCount, 1);
});

test('withRetry 对可重试错误进行重试', async () => {
  let callCount = 0;
  const result = await withRetry(async () => {
    callCount += 1;
    if (callCount < 3) {
      const err = new Error('Connection reset');
      err.code = 'ECONNRESET';
      throw err;
    }
    return 'success after retry';
  }, { maxRetries: 3, initialDelayMs: 10, jitter: false });

  assert.equal(result, 'success after retry');
  assert.equal(callCount, 3);
});

test('withRetry 达到最大重试次数后抛出错误', async () => {
  let callCount = 0;
  await assert.rejects(async () => {
    await withRetry(async () => {
      callCount += 1;
      const err = new Error('Always fails');
      err.code = 'ECONNRESET';
      throw err;
    }, { maxRetries: 2, initialDelayMs: 10, jitter: false });
  }, /Always fails/);

  assert.equal(callCount, 3); // 1 次初始 + 2 次重试
});

test('withRetry 不重试非网络错误', async () => {
  let callCount = 0;
  await assert.rejects(async () => {
    await withRetry(async () => {
      callCount += 1;
      throw new Error('Business error');
    }, { maxRetries: 3, initialDelayMs: 10 });
  }, /Business error/);

  assert.equal(callCount, 1); // 不重试，只调用一次
});

test('AI_RETRY_CONFIG 配置合理', () => {
  assert.equal(AI_RETRY_CONFIG.maxRetries, 1);
  assert.equal(AI_RETRY_CONFIG.initialDelayMs, 2000);
  assert.ok(AI_RETRY_CONFIG.jitter === true);
});
