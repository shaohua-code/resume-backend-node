---
name: resume-backend-node
description: >-
  AI简历助手 Node.js 后端项目指南（Express + Supabase + DeepSeek）。
  在 resume-backend-node 目录编写/修改 API、鉴权、AI 服务、数据库迁移时使用。
  每次改动路由、表结构、权限或配置后须同步更新本 skill 与 reference.md。
---

# resume-backend-node

AI 简历助手校园版后端。Express 4 + Supabase Postgres/Auth + DeepSeek API。

## 何时读取

- 修改 `routers/`、`services/`、`middlewares/`、`utils/`
- 新增 API、权限、AI 任务、数据表
- 排查 401/403/429、CORS、AI 配额问题

详细路由与表结构见 [reference.md](reference.md)。

## 项目结构

```
main.js              # 入口，挂载 /api/auth|resume|admin|upload|feedback + /uploads 静态
config.js            # 环境变量 → settings
supabaseClient.js    # supabaseAuth（Auth）+ supabaseAdmin（DB CRUD）
routers/             # auth.js | resume.js | admin.js | upload.js | feedback.js
middlewares/         # auth.js authRequired | permission.js RBAC
services/            # auth_service | user_profile_service | ai_service
utils/               # permissions.js | ai_cost.js
supabase/schema.sql  # 建表 + RLS + 种子
uploads/             # 运行时文件存储（PDF + uploads/files/ 通用上传）
```

**无 ORM**：直接用 `@supabase/supabase-js` 查询；表结构以 `supabase/schema.sql` 为准。

## 技术约定

| 项 | 约定 |
|----|------|
| 模块 | CommonJS，`require` / `module.exports` |
| 文件命名 | `snake_case.js`（services/utils） |
| 注释 | 中文块注释说明模块职责 |
| 分号 | 使用 |
| 成功响应 | `{ success: true, data, message }` 或 `{ total, items }` |
| 错误响应 | `{ detail: '中文错误信息' }` |
| 用户 ID | Supabase UUID，字段 `user_id` |
| 权限字符串 | `namespace:action`，如 `admin:manage_users` |

## 鉴权流程

1. 前端 `Authorization: Bearer <Supabase access_token>`
2. `authRequired` → `getUserByToken()` → 挂 `req.user`（含 role、permissions）
3. JWT 由 Supabase 签发，后端不自签
4. `user_profile` 存业务角色；VIP 过期由 `getEffectiveRole()` 降级
5. 角色：`SUPER_ADMIN` | `ADMIN` | `VIP` | `USER`（定义于 `utils/permissions.js`）

## 双 Supabase 客户端

- **supabaseAuth**：OTP、login、refresh、getUser
- **supabaseAdmin**：所有 Postgres CRUD、`auth.admin.*`（service_role，绝不可暴露前端）

## 新增 API 检查清单

1. 在 `routers/<module>.js` 添加路由
2. 需登录：`authRequired`；管理端：`requireAdmin` + `requirePermission(PERMISSIONS.XXX)`
3. 复杂逻辑抽到 `services/<name>_service.js`
4. DB 用 `supabaseAdmin.from('table')`
5. 新模块在 `main.js` 挂载 `app.use('/api/xxx', router)`
6. **更新 `reference.md` 路由表**

## 新增 AI 能力

1. `services/ai_service.js` 添加 Prompt + 调用
2. `routers/resume.js` 添加端点，定义 `taskType`（snake_case）
3. 调用 `ensureAiQuota()` + `recordAiCall()`
4. 可选：`config.js` 加 `DEEPSEEK_MODEL_<TASK>`；`ai_model` 表配置单价
5. SSE 格式：`data: ${JSON.stringify({ chunk | done | error })}\n\n`

## 新增数据表

1. `supabase/schema.sql` 或 `supabase/migrations/` 写 SQL
2. 启用 RLS + `service_role` 策略
3. 路由/服务中 Supabase 查询
4. **更新 `reference.md` 表结构**

## 新增权限

1. `utils/permissions.js` 添加 `PERMISSIONS.XXX`
2. 分配到 `ROLE_PERMISSIONS`
3. 路由 `requirePermission()` 或 `hasPermission()` 内联
4. **同步前端 `stores/user.js` 与 Admin 菜单 permission**

## resume_json 字段（AI 与 CRUD 共用）

```
name, target_position, school, major, education, phone, email, summary, avatar,
skills[], projects[], internships[], awards[], certificates[]
```

`avatar` 为上传文件 URL（`/uploads/files/{userId}/...`），可选字段。

## 用户反馈与上传 API

| 路由 | 说明 |
|------|------|
| `POST /api/upload/file` | 统一上传（图片/PDF/文档），需登录 |
| `POST /api/feedback` | 用户提交反馈（body: content_html），服务端 turndown 转 MD |
| `GET /api/admin/feedbacks` | 反馈列表（permission: admin:view_feedback，仅 SUPER_ADMIN） |
| `GET /api/admin/feedbacks/:id` | 反馈详情 |

表 `user_feedback`：content_html、content_md、user_id、create_time。

前端编辑器另存 `_editorSettings`（间距/字体/皮肤/模块显隐），后端按 text 存 `resume_json`。

## 环境变量（config.js）

| 变量 | 默认 | 用途 |
|------|------|------|
| PORT | 8000 | 服务端口 |
| SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY | — | Supabase |
| DEEPSEEK_API_KEY / DEEPSEEK_API_URL | — | AI |
| DEEPSEEK_MODEL | deepseek-v4-flash | 默认模型 |
| CORS_ORIGINS | localhost:5173,3000 | 逗号分隔 |
| APP_FRONTEND_URL | http://localhost:5173 | 密码重置回调 |

复制 `.env.example` → `.env` 填写密钥。

## 启动

```bash
npm run dev   # nodemon，端口 8000
npm start     # node main.js
```

前端 Vite 代理 `/api` → `http://localhost:8000`。

## Skill 维护（必须）

**每次在本项目生成或修改代码后**，检查并更新：

1. 本文件 `SKILL.md`：新增模块、约定变更、重要模式
2. `reference.md`：新/改 API 路径、表字段、权限常量
3. 若影响前端契约，同步更新 `resume-frontend/.cursor/skills/resume-frontend/`

更新原则：只记录 agent 无法从代码一眼推断的项目知识（路由表、权限矩阵、跨端约定），保持简洁。
