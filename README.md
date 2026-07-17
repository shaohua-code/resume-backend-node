# AI 简历后端服务

基于 **Node.js + Express + PostgreSQL + JWT** 的全行业简历 AI 后端 API，当前使用 DeepSeek V4 Flash 处理文本任务、Qwen3.6 Flash 处理视觉任务，并支持由超级管理员按任务切换 OpenAI 兼容模型。

## 技术栈

- 运行框架：[Express](https://expressjs.com/) 4.x
- 数据库：[PostgreSQL](https://www.postgresql.org/)（直连 `pg` 驱动）
- 认证：JWT + bcrypt + QQ/163 SMTP 邮箱验证码
- AI 能力：[DeepSeek API](https://platform.deepseek.com/) + [阿里云百炼](https://help.aliyun.com/zh/model-studio/)
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
├── dbClient.js             # PostgreSQL 数据库客户端（dbAdmin）
├── lib/
│   ├── db.js               # pg 连接池
│   ├── pgCompat.js         # 链式查询兼容层
│   └── uploadPaths.js      # 上传目录路径管理
├── routers/                # 路由入口层：仅定义路径与权限中间件
├── controllers/            # 控制器层：HTTP 请求/响应转换
├── services/               # 业务逻辑层：按业务域拆分子目录
├── repositories/           # 数据访问层：封装 PostgreSQL 表操作
├── middlewares/            # 认证、权限、校验、全局错误处理
├── validators/             # express-validator 参数校验规则
├── utils/                  # 响应封装、JSON 提取、权限、费用计算
├── database/
│   ├── init.sql            # 完整建表脚本（22 张表）
│   ├── TABLES.md           # 表结构中文对照
│   └── ops/                # 运维 SQL（额度初始化、清用户等）
└── data/uploads/           # 本地上传目录（开发默认，生产用 UPLOAD_DIR）
```

### 各层职责

| 目录 | 职责 |
|---|---|
| `routers` | 定义 HTTP 路径、方法、中间件顺序，不处理业务逻辑 |
| `controllers` | 解析请求参数、调用 service、统一返回 success/error |
| `services` | 业务逻辑核心：AI 调用、PDF 处理、简历 CRUD、管理后台统计等 |
| `repositories` | 直接操作 PostgreSQL 数据库，屏蔽 SQL 细节 |
| `middlewares` | `auth` 认证、`permission` 权限、`validate` 参数校验、`errorHandler` 全局错误处理 |
| `validators` | 使用 `express-validator` 声明请求参数规则 |
| `utils` | 跨模块通用工具函数 |

### 业务模块划分

| 目录 | 模块 | 说明 |
|---|---|---|
| `services/wallet/` | 钱包服务 | `wallet.service.js` 余额查询、扣费、注册赠送、管理员调额 |
| `services/ai/` | AI 服务 | `ai.quota.service.js` 余额校验与扣费审计 |
| `services/pdf/` | PDF 服务 | `pdf.service.js` 负责上传、解析、文本提取、文件元信息 |
| `services/resume/` | 简历服务 | `resume.service.js` 处理简历 CRUD 业务 |
| `services/auth/` | 认证服务 | `auth.service.js` JWT + OTP + 密码登录、刷新、密码重置 |
| `services/admin/` | 管理后台 | 按功能拆分为 dashboard、user、order、aiCall、resume、config、crud、feedback 等服务 |
| `repositories/` | 数据仓库 | `resume.repository.js`、`user.repository.js`、`order.repository.js` 等 |

## 路由说明

所有业务接口均以 `/api` 为前缀：

| 前缀 | 路由文件 | 职责 |
|---|---|---|
| `/api/auth` | `routers/auth.js` | 登录、验证码、token 刷新、密码重置 |
| `/api/ai` | `routers/ai.js` | AI 生成、分模块优化、岗位匹配分析、简历评分 |
| `/api/pdf` | `routers/pdf.js` | PDF 上传、解析、AI 整体优化、文件管理 |
| `/api/resume` | `routers/resume.js` | 简历 CRUD、导出记录 |
| `/api/wallet` | `routers/wallet.js` | 用户余额与流水 |
| `/api/admin` | `routers/admin.js` | 管理后台：用户、额度、AI 调用、简历、配置、反馈等 |
| `/api/upload` | `routers/upload.js` | 通用文件上传 |
| `/api/feedback` | `routers/feedback.js` | 用户反馈 |

### 钱包接口

```
GET  /api/wallet/balance           # 当前用户余额
GET  /api/wallet/ledger            # 流水列表
POST /api/admin/users/:id/balance  # 调整额度 { amount, remark }
GET  /api/admin/wallets            # 管理端钱包列表
```

### AI 优化接口

```
POST /api/ai/generate              # AI 生成简历（同步）
POST /api/ai/generate/stream       # AI 生成简历（SSE 流式）
POST /api/ai/optimize              # 项目描述优化（同步，兼容旧接口）
POST /api/ai/optimize/:type/stream # 分模块流式优化
                                   # type: summary | skills | project | internship | work_experience
POST /api/ai/optimize-by-jd/stream # 基于岗位 JD 流式优化整份简历（SSE）
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
PORT=8000

# PostgreSQL
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/ai_resume

# JWT
JWT_SECRET=your-secret
JWT_ACCESS_EXPIRES=1h
JWT_REFRESH_EXPIRES=7d

# SMTP（验证码邮件）
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=your@qq.com
SMTP_PASS=授权码

# DeepSeek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions

# 阿里云百炼 Qwen 视觉模型
DASHSCOPE_API_KEY=your-dashscope-api-key
DASHSCOPE_API_URL=https://your-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions
DASHSCOPE_MODEL_VISION=qwen3.6-flash

# 上传目录（生产建议 /var/www/resume-uploads）
UPLOAD_DIR=/var/www/resume-uploads

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

详见 [`docs/Ubuntu22-纯命令行部署指南.md`](docs/Ubuntu22-纯命令行部署指南.md)。

### PostgreSQL 数据库

首次部署或表结构变更时执行：

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/init.sql
```

表结构中文对照见 [`database/TABLES.md`](database/TABLES.md)。

### 上传目录

生产环境将 `UPLOAD_DIR` 设为独立于 Git 仓库的路径（如 `/var/www/resume-uploads`），避免 `git pull` 覆盖用户文件。

## 主要依赖

| 依赖 | 用途 |
|---|---|
| `express` | Web 框架 |
| `pg` | PostgreSQL 客户端 |
| `jsonwebtoken` / `bcryptjs` | JWT 认证与密码哈希 |
| `nodemailer` | SMTP 邮件发送 |
| `axios` | HTTP 请求，调用 DeepSeek / DashScope OpenAI 兼容 API |
| `multer` | 文件上传中间件 |
| `pdf-parse` | PDF 文本提取 |
| `express-validator` | 请求参数校验 |
| `cors` | 跨域处理 |
| `dotenv` | 环境变量加载 |

## 开发规范

- 路由层只负责路径与中间件顺序，不写业务逻辑。
- 控制器层统一使用 `utils/response.js` 的 `success`/`error` 返回。
- Service 层处理业务规则，Repository 层只操作数据库。
- 所有导出函数均添加中文 JSDoc 注释。
- AI 调用统一经过 `services/ai/ai.quota.service.js` 校验余额并在成功后扣费、记录审计日志。
- 新用户注册在 `user_profile_service.js` 中自动初始化钱包并写入 `REGISTER_GIFT` 流水。

提交代码前阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。输入 `--提交` 时，项目的 `commit-ai-resume` Skill 会审查当前差异、运行必要验证，并按规范创建本地提交；不会自动推送。
