/**
 * Express 应用工厂
 * 负责创建应用实例、注册全局中间件、挂载所有路由模块
 * 数据存储和认证均使用 Supabase（Postgres + Auth）
 */

const express = require('express')
const cors = require('cors')
const path = require('path')
const { settings } = require('./config')
const routes = require('./routers')
const { errorHandler } = require('./middlewares/errorHandler')

const app = express()

// 部署在反向代理后时，正确解析客户端 IP
app.set('trust proxy', 1)

// 请求体解析，限制 10MB 防止大 JSON / base64 图片导致内存问题
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// 跨域配置：读取环境变量中的 CORS_ORIGINS
app.use(
  cors({
    origin: settings.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)

// 健康检查入口
app.get('/', (req, res) => {
  res.json({ message: 'AI Resume Assistant API is running 自动化部署成功', version: '1.0.0', backend: 'Supabase' })
})

// 注册业务路由
app.use('/api', routes)

// 上传文件静态目录
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 全局错误处理中间件
app.use(errorHandler)

module.exports = app
