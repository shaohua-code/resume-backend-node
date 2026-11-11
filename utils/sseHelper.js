/**
 * SSE 流式输出辅助工具
 * 提供统一的流式状态协议、心跳机制和事件发送
 */

/**
 * SSE 事件类型枚举
 * 定义统一的流式状态协议，便于前端统一处理
 */
const SSE_EVENT_TYPE = {
  // 连接/准备阶段
  CONNECTING: 'connecting',      // 正在连接 AI 模型
  CONNECTED: 'connected',        // 模型已连接
  // 生成阶段
  GENERATING: 'generating',      // 正在生成内容
  CHUNK: 'chunk',                // 内容片段
  PROGRESS: 'progress',          // 进度更新
  // 处理阶段
  VALIDATING: 'validating',      // 正在校验结果
  PARSING: 'parsing',            // 正在解析结果
  // 完成/错误
  DONE: 'done',                  // 生成完成
  ERROR: 'error',                // 发生错误
  // 保活
  HEARTBEAT: 'heartbeat',        // 心跳信号
}

/**
 * AI 流式任务阶段枚举
 * 用于前端进度指示器显示，与前端 PR #1 对齐
 * 取值说明：
 * - preparing: 准备阶段，正在初始化任务
 * - connecting: 正在连接 AI 模型服务
 * - analyzing: 正在分析输入内容（简历/JD 等）
 * - generating: 正在生成内容
 * - optimizing: 正在优化内容
 * - extracting: 正在识别/提取信息
 * - validating: 正在校验结果
 * - completed: 任务完成
 */
const AI_STAGE = {
  PREPARING: 'preparing',
  CONNECTING: 'connecting',
  ANALYZING: 'analyzing',
  GENERATING: 'generating',
  OPTIMIZING: 'optimizing',
  EXTRACTING: 'extracting',
  VALIDATING: 'validating',
  COMPLETED: 'completed',
}

/**
 * 创建 SSE 流式响应助手
 * 提供心跳机制、统一事件格式和自动清理
 *
 * @param {Response} res Express 响应对象
 * @param {Object} options 配置选项
 * @param {number} options.heartbeatInterval 心跳间隔（毫秒），默认 15000
 * @param {boolean} options.enableHeartbeat 是否启用心跳，默认 true
 * @returns {Object} SSE 辅助对象
 */
function createSseHelper(res, options = {}) {
  const {
    heartbeatInterval = 15000,
    enableHeartbeat = true,
  } = options

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 关闭反向代理缓冲，确保数据实时推送
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }

  let heartbeatTimer = null
  let isEnded = false
  let lastActivityTime = Date.now()

  /**
   * 发送 SSE 事件
   * @param {Object} payload 事件数据
   */
  function send(payload) {
    if (isEnded) return
    lastActivityTime = Date.now()
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /**
   * 发送带类型的事件
   * @param {string} type 事件类型（来自 SSE_EVENT_TYPE）
   * @param {Object} data 事件数据
   */
  function sendEvent(type, data = {}) {
    send({ type, ...data })
  }

  /**
   * 发送内容片段（向后兼容旧格式）
   * @param {string} chunk 内容片段
   */
  function sendChunk(chunk) {
    // 同时发送旧格式（兼容）和新格式
    send({ chunk })
  }

  /**
   * 发送状态更新（支持 stage 字段，配合前端进度指示器）
   * @param {string} status 状态描述文本
   * @param {string} stage 阶段标识（可选，来自 AI_STAGE 枚举）
   */
  function sendStatus(status, stage = '') {
    const payload = { status }
    if (stage) {
      payload.stage = stage
    }
    send(payload)
  }

  /**
   * 发送进度更新
   * @param {number} current 当前进度
   * @param {number} total 总进度
   * @param {string} message 进度消息
   */
  function sendProgress(current, total, message = '') {
    sendEvent(SSE_EVENT_TYPE.PROGRESS, { current, total, message })
  }

  /**
   * 发送心跳信号
   */
  function sendHeartbeat() {
    if (isEnded) return
    const idleTime = Date.now() - lastActivityTime
    send({
      type: SSE_EVENT_TYPE.HEARTBEAT,
      timestamp: Date.now(),
      idleMs: idleTime,
    })
  }

  /**
   * 发送完成事件并结束连接
   * @param {Object} data 完成数据
   */
  function sendDone(data = {}) {
    send({ done: true, ...data })
    end()
  }

  /**
   * 发送错误事件并结束连接
   * @param {string} message 错误消息
   * @param {string} code 错误码
   */
  function sendError(message, code = '') {
    const payload = { error: message }
    if (code) payload.code = code
    send(payload)
    end()
  }

  /**
   * 启动心跳定时器
   */
  function startHeartbeat() {
    if (!enableHeartbeat || heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      // 只在没有活动时发送心跳，避免干扰正常数据流
      const idleTime = Date.now() - lastActivityTime
      if (idleTime >= heartbeatInterval * 0.8) {
        sendHeartbeat()
      }
    }, heartbeatInterval)
  }

  /**
   * 停止心跳定时器
   */
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * 结束 SSE 连接
   */
  function end() {
    if (isEnded) return
    isEnded = true
    stopHeartbeat()
    res.end()
  }

  // 监听连接关闭，自动清理定时器
  res.on('close', () => {
    isEnded = true
    stopHeartbeat()
  })

  // 自动启动心跳
  if (enableHeartbeat) {
    startHeartbeat()
  }

  return {
    send,
    sendEvent,
    sendChunk,
    sendStatus,
    sendProgress,
    sendHeartbeat,
    sendDone,
    sendError,
    startHeartbeat,
    stopHeartbeat,
    end,
    get isEnded() { return isEnded },
  }
}

/**
 * 创建 AI 模型调用状态回调（与 ai.service.js 配合使用）
 * 同时发送 status 文本和 stage 阶段标识，配合前端进度指示器
 * @param {Object} sseHelper SSE 辅助对象
 * @param {string} taskStage 任务主阶段（如 generating/optimizing/extracting）
 * @returns {Function} 状态回调函数
 */
function createModelStatusCallback(sseHelper, taskStage = AI_STAGE.GENERATING) {
  return (internalStage, message) => {
    // 内部阶段到前端 stage 的映射
    const stageMap = {
      connecting: AI_STAGE.CONNECTING,
      model: AI_STAGE.ANALYZING,      // 模型已连接，开始分析
      generating: taskStage,           // 使用任务主阶段
      validating: AI_STAGE.VALIDATING,
      parsing: AI_STAGE.VALIDATING,
    }
    const stage = stageMap[internalStage] || taskStage
    // 发送带 stage 的状态事件
    sseHelper.sendStatus(message, stage)
  }
}

module.exports = {
  SSE_EVENT_TYPE,
  AI_STAGE,
  createSseHelper,
  createModelStatusCallback,
}
