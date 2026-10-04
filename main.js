/**
 * 服务启动入口
 * 仅负责引入 Express 应用实例并监听端口
 * 运行方式：npm run dev 或 npm start
 */

const app = require('./app')
const { settings } = require('./config')
const { startInterviewQuestionWorker } = require('./services/interview/interviewQuestion.worker')

app.listen(settings.PORT,'0.0.0.0',  () => {
  // 持久化题库任务随 API 服务启动，由 PostgreSQL 队列负责跨请求和多实例恢复。
  startInterviewQuestionWorker()
  console.log(`[服务] 已启动11: http://localhost:${settings.PORT}`)
})
