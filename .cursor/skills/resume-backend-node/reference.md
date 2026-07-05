# resume-backend-node API 与数据速查

## 路由前缀

| 前缀 | 文件 | 鉴权 |
|------|------|------|
| `/api/auth` | `routers/auth.js` | 公开 |
| `/api/resume` | `routers/resume.js` | `authRequired` 全路由 |
| `/api/admin` | `routers/admin.js` | `authRequired` + `requireAdmin` + 细粒度 permission |

## Auth `/api/auth`

| Method | Path | 说明 |
|--------|------|------|
| POST | `/sendCode` | 发送邮箱 OTP |
| POST | `/login` | 验证码登录（首次自动注册） |
| POST | `/register` | 验证码 + 用户名 + 密码 |
| POST | `/loginPassword` | 用户名/邮箱 + 密码 |
| POST | `/refresh` | 刷新 token |
| POST | `/resetPassword` | 发送重置验证码 |
| POST | `/updatePassword` | 验证码 + 新密码 |

登录成功字段：`token`, `refresh_token`, `expires_at`, `email`, `nickname`, `user_id`, `role`, `status`, `vip_expire_time`, `permissions`

## Resume `/api/resume`（均需 Bearer）

### AI

| Method | Path | task_type |
|--------|------|-----------|
| POST | `/generate` | resume_generate |
| POST | `/generate/stream` | resume_generate（SSE） |
| POST | `/optimize` | project_optimize |
| POST | `/match` | jd_match |
| POST | `/score` | score |
| POST | `/uploadOptimize` | pdf_optimize |
| POST | `/uploadOptimize/stream` | pdf_optimize（SSE） |
| POST | `/uploadOptimize/existing` | pdf_optimize |
| POST | `/uploadOptimize/existing/stream` | pdf_optimize（SSE） |

可选参数：`model`（指定 DeepSeek 模型）

### CRUD

| Method | Path | 说明 |
|--------|------|------|
| POST | `/create` | 新建 |
| PUT | `/update/:id` | 更新 |
| POST | `/save` | 兼容（有 id 更新，无 id 创建） |
| GET | `/list` | `?page=&size=` |
| GET | `/detail` | `?resume_id=` |
| DELETE | `/delete` | `?resume_id=` 或 body |
| POST | `/export` | 记录导出（需 VIP_EXPORT） |

### PDF 文件

| Method | Path | 说明 |
|--------|------|------|
| GET | `/uploadedFile` | 当前用户已上传 PDF |
| DELETE | `/uploadedFile` | 删除已上传 PDF |

## Admin `/api/admin`

全局：`authRequired` → `requireAdmin`

| Method | Path | Permission |
|--------|------|------------|
| GET | `/stats` | admin:stats |
| GET | `/dashboard` | admin:stats |
| GET | `/users` | admin:manage_users |
| GET | `/users/:userId` | admin:manage_users |
| PATCH | `/users/:userId` | admin:manage_users |
| POST | `/users/:userId/reset-password` | admin:manage_users |
| GET | `/orders` | admin:view_orders |
| POST | `/orders` | admin:manage_orders |
| PATCH | `/orders/:id` | admin:manage_orders |
| GET | `/ai-calls` | admin:view_ai_calls |
| GET | `/resumes` | admin:view_resumes |
| GET | `/resumes/:id` | admin:view_resumes |
| GET | `/configs` | admin:system_config |
| PUT | `/configs/:key` | admin:system_config |

CRUD 生成器 `createCrudRoutes`：

| 前缀 | 表 | Permission |
|------|-----|------------|
| `/plans` | membership_plan | admin:membership_plan |
| `/announcements` | announcement | admin:announcement |
| `/models` | ai_model | admin:ai_model |

每前缀：`GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`

## 数据表（supabase/schema.sql）

| 表 | 关键字段 |
|----|----------|
| resume | id, user_id, title, resume_json(text), template_id, score |
| user_profile | user_id, email, nickname, role, status, vip_expire_time |
| export_record | user_id, resume_id |
| membership_plan | name, price, duration_days, enabled |
| order_record | order_no, amount, status |
| ai_call_record | task_type, model, tokens, cost, success |
| system_config | config_key, config_value(jsonb) |
| announcement | title, content, enabled |
| ai_model | model_key, vip_only, 单价 |
| admin_action_log | admin_user_id, action, target_type/id |

## 权限（utils/permissions.js 节选）

**管理：** admin:dashboard, admin:stats, admin:manage_users, admin:manage_admins, admin:view_orders, admin:manage_orders, admin:view_ai_calls, admin:view_resumes, admin:system_config, admin:membership_plan, admin:announcement, admin:ai_model

**用户：** user:resume_create, user:resume_edit, user:ai_limited

**VIP：** vip:ai_unlimited, vip:export, vip:advanced_model, vip:exclusive_template

## AI 配额

- 配置 `system_config.ai_daily_limit`：`{ "USER": 3, "VIP": -1 }`（-1 不限）
- 按 user_id + task_type + 当日统计 ai_call_record
- 管理员或 vip:ai_unlimited 跳过

## 超级管理员初始化

```sql
UPDATE user_profile SET role = 'SUPER_ADMIN' WHERE email = 'your@email.com';
```
