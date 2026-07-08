# AI 简历助手后端服务

基于 **Node.js + Express + Supabase（Postgres + Auth）** 的简历 AI 后端 API，接入 DeepSeek 大模型提供简历生成、分模块优化、JD 匹配、简历评分、PDF 解析优化等能力。

## 技术栈

- 运行框架：[Express](https://expressjs.com/) 4.x
- 数据库与认证：[Supabase](https://supabase.com/)（PostgreSQL + Auth）
- AI 能力：[DeepSeek API](https://platform.deepseek.com/)
- 文件上传：[multer](https://github.com/expressjs/multer)
- PDF 解析：[pdf-parse](https://github.com/mozilla/pdf-parse)
- 参数校验：[express-validator](https://express-validator.github.io/)
- 环境变量：[dotenv](https://github.com/motdotla/dotenv)

## 目录结构

```
resume-backend-node/
├── app.js                  # Express 应用工厂：中间件、路由挂载
├── main.js                 # 服务启动入口
├── config.js               # 环境变量与全局配置
├── supabaseClient.js       # Supabase 客户端（auth / admin）
├── routers/                # 路由入口层：仅定义路径与权限中间件
├── controllers/            # 控制器层：HTTP 请求/响应转换
├── services/               # 业务逻辑层：按业务域拆分子目录
├── repositories/           # 数据访问层：封装 Supabase 表操作
├── middlewares/            # 认证、权限、校验、全局错误处理
├── validators/             # express-validator 参数校验规则
├── utils/                  # 响应封装、JSON 提取、权限、费用计算
├── supabase/               # 数据库迁移脚本
└── uploads/                # 本地上传文件目录
```

### 各层职责

| 目录 | 职责 |
|---|---|
| `routers` | 定义 HTTP 路径、方法、中间件顺序，不处理业务逻辑 |
| `controllers` | 解析请求参数、调用 service、统一返回 success/error |
| `services` | 业务逻辑核心：AI 调用、PDF 处理、简历 CRUD、管理后台统计等 |
| `repositories` | 直接操作 Supabase 数据库，屏蔽 SQL/ORM 细节 |
| `middlewares` | `auth` 认证、`permission` 权限、`validate` 参数校验、`errorHandler` 全局错误处理 |
| `validators` | 使用 `express-validator` 声明请求参数规则 |
| `utils` | 跨模块通用工具函数 |

### 业务模块划分

| 目录 | 模块 | 说明 |
|---|---|---|
| `services/ai/` | AI 服务 | `ai.service.js` 调用 DeepSeek；`ai.prompts.js` 管理 Prompt；`ai.model.js` 管理任务常量与模型选择；`ai.quota.service.js` 管理调用配额与审计 |
| `services/pdf/` | PDF 服务 | `pdf.service.js` 负责上传、解析、文本提取、文件元信息 |
| `services/resume/` | 简历服务 | `resume.service.js` 处理简历 CRUD 业务 |
| `services/auth/` | 认证服务 | `auth.service.js` 基于 Supabase Auth 实现 OTP、密码登录、刷新、密码重置 |
| `services/admin/` | 管理后台 | 按功能拆分为 dashboard、user、order、aiCall、resume、config、crud、feedback 等服务 |
| `repositories/` | 数据仓库 | `resume.repository.js`、`user.repository.js`、`order.repository.js`、`aiCall.repository.js`、`config.repository.js`、`feedback.repository.js` |

## 路由说明

所有业务接口均以 `/api` 为前缀：

| 前缀 | 路由文件 | 职责 |
|---|---|---|
| `/api/auth` | `routers/auth.js` | 登录、验证码、token 刷新、密码重置 |
| `/api/ai` | `routers/ai.js` | AI 生成、分模块优化、JD 匹配、简历评分 |
| `/api/pdf` | `routers/pdf.js` | PDF 上传、解析、AI 整体优化、文件管理 |
| `/api/resume` | `routers/resume.js` | 简历 CRUD、导出记录 |
| `/api/admin` | `routers/admin.js` | 管理后台：用户、订单、AI 调用、简历、配置、反馈等 |
| `/api/upload` | `routers/upload.js` | 通用文件上传 |
| `/api/feedback` | `routers/feedback.js` | 用户反馈 |

### AI 优化接口

```
POST /api/ai/generate              # AI 生成简历（同步）
POST /api/ai/generate/stream       # AI 生成简历（SSE 流式）
POST /api/ai/optimize              # 项目描述优化（同步，兼容旧接口）
POST /api/ai/optimize/:type/stream # 分模块流式优化
                                   # type: summary | skills | project | internship
POST /api/ai/match                 # JD 岗位匹配
POST /api/ai/score                 # AI 简历评分
```

### PDF 优化接口

```
POST /api/pdf/uploadOptimize                  # 上传 PDF 同步优化
POST /api/pdf/uploadOptimize/stream           # 上传 PDF 流式优化
POST /api/pdf/uploadOptimize/existing         # 已有 PDF 同步优化
POST /api/pdf/uploadOptimize/existing/stream  # 已有 PDF 流式优化
GET  /api/pdf/uploadedFile                    # 已上传文件元信息
DELETE /api/pdf/uploadedFile                  # 删除已上传文件
```

## 环境变量

创建 `.env` 文件，参考以下变量：

```env
# 服务端口
PORT=3000

# Supabase 配置
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key

# DeepSeek 配置
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_MODEL=deepseek-v4-flash

# CORS 白名单（逗号分隔）
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

> 注意：`.env` 文件已加入 `.gitignore`，请勿提交到版本控制。

## 启动命令

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产模式
npm start
```

## 部署说明

### Render 部署

1. 在 Render 创建 Web Service，选择本仓库。
2. 设置 Build Command：`npm install`。
3. 设置 Start Command：`npm start`。
4. 在 Environment 中填入上述所有环境变量。
5. （可选）配置 UptimeRobot 每 14 分钟 ping 一次健康检查接口 `/`，避免 Render 免费实例 15 分钟无访问后进入冷启动。

### Supabase 数据库

首次部署或表结构变更时，需要在 Supabase SQL Editor 中执行：

```bash
supabase/migrations/*.sql
# 或
supabase/schema.sql
```

## 主要依赖

| 依赖 | 用途 |
|---|---|
| `express` | Web 框架 |
| `@supabase/supabase-js` | Supabase 数据库与认证客户端 |
| `axios` | HTTP 请求，调用 DeepSeek API |
| `multer` | 文件上传中间件 |
| `pdf-parse` | PDF 文本提取 |
| `express-validator` | 请求参数校验 |
| `cors` | 跨域处理 |
| `dotenv` | 环境变量加载 |
| `turndown` | HTML 转 Markdown |
| `ws` | WebSocket（如后续需要） |

## 开发规范

- 路由层只负责路径与中间件顺序，不写业务逻辑。
- 控制器层统一使用 `utils/response.js` 的 `success`/`error` 返回。
- Service 层处理业务规则，Repository 层只操作数据库。
- 所有导出函数均添加中文 JSDoc 注释。
- AI 调用统一经过 `services/ai/ai.quota.service.js` 校验配额并记录审计日志。
