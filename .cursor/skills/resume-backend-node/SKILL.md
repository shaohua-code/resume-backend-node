---
name: resume-backend-node
description: >-
  AI简历助手 Node.js 后端项目指南（Express + Supabase + DeepSeek）。
  在 resume-backend-node 目录编写/修改 API、鉴权、AI 服务、钱包计费、数据库迁移时使用。
  每次改动路由、表结构、权限或配置后须同步更新本 skill 与 reference.md。
---

# resume-backend-node

AI 简历助手校园版后端。Express 4 + Supabase Postgres/Auth + DeepSeek API。**计费模式：账户余额 + AI 按次扣费（已移除 VIP 会员体系）。**

## 何时读取

- 修改 `routers/`、`services/`、`middlewares/`、`utils/`
- 新增 API、权限、AI 任务、钱包/流水、数据表
- 排查 401/403/402、CORS、余额不足问题

详细路由与表结构见 [reference.md](reference.md)。

## 项目结构

```
main.js              # 入口
routers/             # auth | ai | pdf | resume | wallet | admin | upload | feedback
services/
  wallet/            # wallet.service.js 余额/扣费/调额
  ai/                # ai.service + ai.quota.service（余额校验+扣费）
middlewares/         # auth | permission
utils/               # permissions.js | ai_cost.js
supabase/
  schema.sql
  migrations/20260709_token_billing.sql
```

## 技术约定

| 项 | 约定 |
|----|------|
| 模块 | CommonJS |
| 成功响应 | `{ success: true, data }` 或 `{ total, items }` |
| 错误响应 | `{ detail, code? }` |
| 用户 ID | Supabase UUID，`user_id` |
| 权限 | `namespace:action`，如 `wallet:view_self` |

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

## Skill 维护（必须）

改动路由/表/权限/计费后同步更新本文件与 `reference.md`，并视情况更新前端 skill。
