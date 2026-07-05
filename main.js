/**
 * Express 应用入口文件
 * 数据存储和认证均使用 Supabase（Postgres + Auth）
 * 运行方式：npm run dev  或  npm start
 */

const express = require('express');
const cors = require('cors');
const { settings } = require('./config');
const authRouter = require('./routers/auth');
const resumeRouter = require('./routers/resume');
const adminRouter = require('./routers/admin');

const app = express();
console.log('settings',settings);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
console.log(settings.CORS_ORIGINS);
app.use(
  cors({
    origin: settings.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.get('/', (req, res) => {
  res.json({ message: 'AI Resume Assistant API is running', version: '1.0.0', backend: 'Supabase' });
});

app.use('/api/auth', authRouter);
app.use('/api/resume', resumeRouter);
app.use('/api/admin', adminRouter);

app.use((err, req, res, next) => {
  console.error('[全局错误]', err);
  res.status(500).json({ detail: err.message || '服务器内部错误' });
});

app.listen(settings.PORT, () => {
  console.log(`[服务] 已启动: http://localhost:${settings.PORT}`);
});
