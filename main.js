/**
 * 服务启动入口
 * 仅负责引入 Express 应用实例并监听端口
 * 运行方式：npm run dev 或 npm start
 */

const app = require('./app')
const { settings } = require('./config')

app.listen(settings.PORT,'0.0.0.0',  () => {
  console.log(`[服务] 已启动11: http://localhost:${settings.PORT}`)
})
