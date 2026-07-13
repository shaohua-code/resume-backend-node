---
name: resume-backend-node
description: >-
  AI简历助手 Node.js 后端项目指南（Express + PostgreSQL + DeepSeek）。
  在 resume-backend-node 目录编写/修改 API、鉴权、AI 服务、钱包计费、数据库迁移时使用。
  每次进入项目任务先阅读本 skill、reference.md 与前端 skill；改动路由、字段、AI Prompt、
  表结构、权限或配置后须同步更新本 skill、reference.md 与 docs/PRD.md。
---

# resume-backend-node

AI 简历助手全行业后端。覆盖校招、社招、转岗以及技术、职能、销售、制造、教育、医疗、金融、服务业等岗位。Express 4 + PostgreSQL + JWT + DeepSeek API。**计费模式：账户余额 + AI 按次扣费（已移除 VIP 会员体系）。**

## 何时读取

- 修改 `routers/`、`services/`、`middlewares/`、`utils/`
- 新增 API、权限、AI 任务、钱包/流水、数据表
- 排查 401/403/402、CORS、余额不足问题
- 修改 AI Prompt、简历字段契约、前后端联动功能

详细路由与表结构见 [reference.md](reference.md)。

## 项目结构

```
main.js              # 入口
dbClient.js          # dbAdmin 数据库客户端
lib/
  db.js              # pg 连接池
  pgCompat.js        # 链式查询兼容层
  uploadPaths.js     # UPLOAD_DIR 上传路径
routers/             # auth | ai | pdf | resume | wallet | admin | upload | feedback
services/
  wallet/            # wallet.service.js 余额/扣费/调额
  ai/                # ai.service + ai.quota.service（余额校验+扣费）
middlewares/         # auth | permission
utils/               # permissions.js | ai_cost.js
database/
  init.sql           # 建表（21 张表）
  TABLES.md          # 表中文对照
  ops/               # 运维 SQL
```

## 技术约定

| 项 | 约定 |
|----|------|
| 模块 | CommonJS |
| 成功响应 | `{ success: true, data }` 或 `{ total, items }` |
| 错误响应 | `{ detail, code? }` |
| 用户 ID | UUID，`user_id` |
| 权限 | `namespace:action`，如 `wallet:view_self` |
| 上传目录 | `UPLOAD_DIR` 环境变量，生产建议 `/var/www/resume-uploads` |

## 鉴权流程

1. `authRequired` → `req.user`（含 role、permissions）
2. 角色：`SUPER_ADMIN` | `ADMIN` | `USER`（`utils/permissions.js`）
3. 管理端：`requireAdmin` + `requirePermission()`

## 钱包计费

1. 新用户：`ensureUserProfile` → `initWalletForNewUser` → `REGISTER_GIFT`（默认 10 元，配置 `register_gift_amount`）
2. AI 前：`ensureAiQuota` → 校验余额 ≥ 0.01 元
3. AI 后：`recordAiCall` → 写 `ai_call_record` + `deductForAiCall` → `balance_ledger`
4. 管理调额：`POST /api/admin/users/:userId/balance`（管理员仅可给 USER 加额度）

## 新增 API 检查清单

1. `routers/<module>.js` 添加路由
2. 需登录：`authRequired`；管理端加 permission
3. 业务逻辑放 `services/`
4. **更新 reference.md**

## 新增 AI 能力

1. `services/ai/` 添加 Prompt + 调用
2. 路由定义 `taskType`
3. `ensureAiQuota()` + `recordAiCall()`（自动扣费）
4. SSE：`data: ${JSON.stringify({ chunk | done | error })}\n\n`

## AI Prompt 与简历字段约定

1. 不得默认互联网、技术岗或校招；必须根据 `target_position`、JD 与原始经历选择行业表达。
2. 不得编造公司、岗位、职责、技能、资质或量化结果；原文无数据时使用可核验的定性成果。
3. `projects.tech_stack` 对非技术岗表示项目使用的专业技能、工具、平台或方法。
4. 标准结构同时包含 `educations[]`、`projects[]`、`internships[]`、`work_experiences[]`、`skills[]`、`awards[]`、`certificates[]`。
5. 分模块优化支持 `summary | skills | project | internship | work_experience`；默认方向使用“通用职业方向”。

## Skill 维护（必须）

每次项目任务先阅读本文件和前端 skill。改动路由、字段、Prompt、表、权限、计费或跨端行为后，同步更新本文件、`reference.md`、前端 skill（如相关）与 `../docs/PRD.md`。
