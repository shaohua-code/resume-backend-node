# AI 简历助手 — Ubuntu 22 + 宝塔 部署指南

> 适用环境：全新 Ubuntu 22.04 服务器 + 宝塔面板 + PostgreSQL + Node.js 后端  
> 项目已从 Supabase 迁移为自建 PostgreSQL + JWT 认证 + 邮箱验证码

---

## 目录

1. [整体架构](#1-整体架构)
2. [服务器初始化](#2-服务器初始化)
3. [安装宝塔面板](#3-安装宝塔面板)
4. [安装 PostgreSQL 并建库](#4-安装-postgresql-并建库)
5. [执行建表 SQL](#5-执行建表-sql)
6. [部署后端代码](#6-部署后端代码)
7. [配置环境变量 .env](#7-配置环境变量-env)
8. [PM2 守护进程](#8-pm2-守护进程)
9. [Nginx 反向代理](#9-nginx-反向代理)
10. [部署前端（可选）](#10-部署前端可选)
11. [创建超级管理员](#11-创建超级管理员)
12. [验证清单](#12-验证清单)
13. [常见问题](#13-常见问题)

---

## 1. 整体架构

```
用户浏览器
    │
    ▼
Nginx (80/443)  ──→  前端静态文件 (Vue3)
    │
    └── /api/*  ──→  Node.js Express (PM2, 端口 8000)
                          │
                          ├── PostgreSQL (127.0.0.1:5432, 库 ai-resume)
                          ├── 163/QQ SMTP (发验证码)
                          └── DeepSeek API (AI 能力)
```

**你的服务器信息（示例）：**

| 项 | 值 |
|----|-----|
| 公网 IP | `175.178.62.55` |
| 系统 | Ubuntu 22.04 |
| 数据库名 | `ai-resume` |
| 数据库用户 | `ai-resume` |
| 后端端口 | `8000` |

---

## 2. 服务器初始化

### 2.1 SSH 登录服务器

在你本机 PowerShell 执行：

```powershell
ssh root@175.178.62.55
```

首次连接输入 `yes`，再输入 root 密码。

### 2.2 更新系统

```bash
apt update && apt upgrade -y
```

### 2.3 腾讯云安全组（必做）

登录腾讯云控制台 → 云服务器 → 安全组 → 入站规则，放行：

| 端口 | 协议 | 来源 | 说明 |
|------|------|------|------|
| 22 | TCP | 你的 IP 或 0.0.0.0/0 | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP |
| 443 | TCP | 0.0.0.0/0 | HTTPS |
| 8888 | TCP | 你的 IP | 宝塔面板（安装后） |
| 8000 | TCP | 可不开放 | 仅 Nginx 内网转发，勿对公网开放 |

> **5432（PostgreSQL）不要对公网开放**，后端与数据库同机时用 `127.0.0.1` 连接即可。

---

## 3. 安装宝塔面板

### 3.1 一键安装（Ubuntu 22）

```bash
wget -O install.sh https://download.bt.cn/install/install-ubuntu_6.0.sh && sudo bash install.sh ed8484bec
```

安装完成后终端会显示：

- 面板地址：`http://175.178.62.55:8888/xxxxxxxx`
- 用户名和密码

**请立即保存！**

### 3.2 登录宝塔

浏览器打开面板地址，用显示的账号密码登录。

首次登录会提示安装套件，先选 **LNMP** 或 **只装 Nginx** 即可（PostgreSQL 后面单独装）。

---

## 4. 安装 PostgreSQL 并建库

### 4.1 安装 PostgreSQL

1. 宝塔左侧 → **软件商店**
2. 搜索 **PostgreSQL**
3. 安装（推荐 **14** 或 **16** 版本）
4. 等待安装完成

### 4.2 创建数据库

1. 宝塔左侧 → **数据库** → 顶部切到 **PostgreSQL**
2. 点击 **添加数据库**
3. 填写：

| 字段 | 值 |
|------|-----|
| 数据库名 | `ai-resume` |
| 用户名 | `ai-resume` |
| 密码 | 自行设置（记下来，如 `sss980318..`） |
| 访问权限 | **本地服务器** |

4. 点击提交

完成后列表中应出现 `ai-resume`，备注显示「本地数据库」。

---

## 5. 执行建表 SQL

数据库创建后是空的，必须执行项目里的建表脚本。

### 5.1 找到 SQL 文件

项目路径（本地）：

```
resume-backend-node/database/init.sql
```

该脚本会创建 **20 张表** + 种子数据（AI 模型、系统配置等）。

### 5.2 在宝塔执行 SQL

**方式 A：管理界面执行（推荐）**

1. 数据库 → PostgreSQL → 找到 `ai-resume`
2. 点击 **管理**（或 phpPgAdmin / Adminer）
3. 进入 **SQL** / **查询** 页面
4. 打开 `database/init.sql`，**全选复制**
5. 粘贴到 SQL 输入框 → 点击 **执行**

**方式 B：导入文件**

1. 点击 `ai-resume` 行「备份」列的 **导入**
2. 上传 `init.sql` 文件
3. 确认执行

### 5.3 验证建表成功

在 SQL 界面执行：

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
```

**预期结果：`20`**

查看所有表名：

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;
```

应包含：`users`、`user_profile`、`resume`、`otp_codes`、`refresh_tokens`、`ai_model` 等。

---

## 6. 部署后端代码

### 6.1 安装 Node.js（若宝塔未装）

宝塔 → 软件商店 → 搜索 **Node 版本管理器** → 安装 → 安装 **Node 18** 或 **20**

或在终端：

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs
node -v   # 应显示 v18.x
npm -v
```

### 6.2 上传代码到服务器

**方式 A：Git 克隆（推荐）**

```bash
mkdir -p /www/wwwroot
cd /www/wwwroot
git clone https://你的仓库地址/resume-backend-node.git
cd resume-backend-node
npm install --production
```

**方式 B：本地上传**

在本机 PowerShell：

```powershell
scp -r "d:\project\新建文件夹\resume-backend-node" root@175.178.62.55:/www/wwwroot/
```

然后在服务器：

```bash
cd /www/wwwroot/resume-backend-node
npm install --production
```

### 6.3 创建上传目录

```bash
mkdir -p /www/wwwroot/resume-backend-node/uploads
chmod 755 /www/wwwroot/resume-backend-node/uploads
```

---

## 7. 配置环境变量 .env

在服务器编辑：

```bash
nano /www/wwwroot/resume-backend-node/.env
```

写入以下内容（**按实际修改**）：

```env
# ========== PostgreSQL（同机部署用 127.0.0.1）==========
DATABASE_URL=postgresql://ai-resume:你的数据库密码@127.0.0.1:5432/ai-resume

# ========== JWT 认证 ==========
JWT_SECRET=请替换为一串随机长字符串至少32位
JWT_ACCESS_EXPIRES=1h
JWT_REFRESH_EXPIRES=7d

# ========== 163 邮箱 SMTP ==========
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱@163.com
SMTP_PASS=163邮箱授权码
SMTP_FROM=你的邮箱@163.com

# ========== 服务端口 ==========
PORT=8000

# ========== DeepSeek API ==========
DEEPSEEK_API_KEY=你的DeepSeek密钥
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions

# ========== 跨域（改成你的前端域名）==========
CORS_ORIGINS=http://localhost:5173,https://你的前端域名.com

# ========== 前端地址 ==========
APP_FRONTEND_URL=https://你的前端域名.com
```

保存：`Ctrl+O` → 回车 → `Ctrl+X`

### 163 邮箱授权码获取

1. 登录 163 邮箱 → 设置 → POP3/SMTP/IMAP
2. 开启 **SMTP 服务**
3. 获取 **授权码**（不是登录密码）
4. 填入 `SMTP_PASS`

### 测试能否启动

```bash
cd /www/wwwroot/resume-backend-node
node main.js
```

看到 `[服务] 已启动: http://localhost:8000` 表示成功。`Ctrl+C` 停止，下一步用 PM2 守护。

---

## 8. PM2 守护进程

### 8.1 安装 PM2

```bash
npm install -g pm2
```

### 8.2 创建 PM2 配置

```bash
nano /www/wwwroot/resume-backend-node/ecosystem.config.js
```

写入：

```javascript
module.exports = {
  apps: [{
    name: 'resume-backend-node',
    script: 'main.js',
    cwd: '/www/wwwroot/resume-backend-node',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
  }],
}
```

### 8.3 启动并设置开机自启

```bash
cd /www/wwwroot/resume-backend-node
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

执行 `pm2 startup` 后会出现一行 `sudo env PATH=...` 命令，**复制并执行**。

### 8.4 常用 PM2 命令

```bash
pm2 status                        # 查看状态
pm2 logs resume-backend-node      # 查看日志
pm2 restart resume-backend-node   # 重启
pm2 stop resume-backend-node      # 停止
```

### 8.5 测试 API

```bash
curl http://127.0.0.1:8000/
```

有响应即正常。

---

## 9. Nginx 反向代理

### 9.1 宝塔添加网站

1. 宝塔 → **网站** → **添加站点**
2. 域名填你的域名（或先用 IP 测试）
3. PHP 选 **纯静态**
4. 创建

### 9.2 配置反向代理

1. 点网站 → **设置** → **反向代理**
2. 添加反向代理：

| 项 | 值 |
|----|-----|
| 代理名称 | `api` |
| 目标 URL | `http://127.0.0.1:8000` |
| 发送域名 | `$host` |

3. 保存

### 9.3 手动 Nginx 配置（备选）

网站 → 设置 → 配置文件，在 `server` 块内添加：

```nginx
# API 反向代理
location /api {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
    proxy_buffering off;
}

# 上传文件静态访问
location /uploads {
    proxy_pass http://127.0.0.1:8000;
}

# 允许上传 PDF（最大 20MB）
client_max_body_size 20m;
```

### 9.4 HTTPS（有域名时）

网站 → 设置 → **SSL** → **Let's Encrypt** → 申请免费证书 → 开启强制 HTTPS

---

## 10. 部署前端（可选）

### 方式 A：宝塔静态托管

1. 本地构建：

```powershell
cd "d:\project\新建文件夹\resume-frontend"
# 修改 .env.production
# VITE_API_URL=https://你的域名.com
npm run build
```

2. 将 `dist/` 目录上传到网站根目录（如 `/www/wwwroot/你的域名/`）

3. 网站设置 → 配置文件，添加 SPA 路由回退：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

### 方式 B：继续用 Vercel

在 Vercel 环境变量设置：

```
VITE_API_URL=https://你的API域名.com
```

---

## 11. 创建超级管理员

### 11.1 先注册一个普通账号

1. 打开前端网站
2. 用邮箱注册并完成验证
3. 确认能正常登录

### 11.2 在宝塔 SQL 提升为超管

数据库 → PostgreSQL → `ai-resume` → 管理 → SQL，执行：

```sql
-- 把邮箱换成你刚注册的邮箱
UPDATE public.user_profile
SET role = 'SUPER_ADMIN', status = 'ACTIVE', update_time = now()
WHERE email = '你的邮箱@163.com';

INSERT INTO public.admin_quota_pool (admin_id, total_quota, allocated_quota, update_time)
SELECT user_id, 1000000, 0, now()
FROM public.user_profile
WHERE email = '你的邮箱@163.com'
ON CONFLICT (admin_id) DO NOTHING;
```

### 11.3 验证

重新登录后应能看到管理后台入口。

---

## 12. 验证清单

按顺序打勾：

```
□ 1. SSH 能登录服务器
□ 2. 宝塔面板能打开
□ 3. PostgreSQL 已安装，库 ai-resume 已创建
□ 4. init.sql 已执行，表数量 = 20
□ 5. 后端代码在 /www/wwwroot/resume-backend-node
□ 6. .env 已配置（DATABASE_URL 用 127.0.0.1）
□ 7. pm2 status 显示 online
□ 8. curl http://127.0.0.1:8000/ 有响应
□ 9. Nginx 反向代理 /api 正常
□ 10. 前端能发验证码、注册、登录
□ 11. 超管 SQL 已执行，管理后台可进
□ 12. AI 生成简历功能正常
```

---

## 13. 常见问题

### Q1: 数据库连接失败 `Connection terminated unexpectedly`

**原因：** 用了公网 IP 连数据库，但 PostgreSQL 只允许本地连接。

**解决：** `.env` 中改为：

```env
DATABASE_URL=postgresql://ai-resume:密码@127.0.0.1:5432/ai-resume
```

### Q2: `relation "users" does not exist`

**原因：** 未执行 `database/init.sql`。

**解决：** 回到 [第 5 步](#5-执行建表-sql) 执行建表脚本。

### Q3: 验证码邮件发不出去

**排查：**

1. 看 PM2 日志：`pm2 logs resume-backend-node`
2. 确认 163 授权码正确（不是登录密码）
3. 未配 SMTP 时，验证码会打印在日志里：

```
[email] SMTP 未配置，验证码 → xxx@163.com: 123456
```

### Q4: 前端报 CORS 错误

**解决：** `.env` 的 `CORS_ORIGINS` 加上前端完整地址（含 `https://`），改完后：

```bash
pm2 restart resume-backend-node
```

### Q5: AI 接口超时

**解决：** Nginx 配置中加：

```nginx
proxy_read_timeout 120s;
proxy_buffering off;
```

### Q6: 更新代码后如何重新部署

```bash
cd /www/wwwroot/resume-backend-node
git pull origin main
npm install --production
pm2 restart resume-backend-node
```

或执行项目自带脚本（需先取消 `deploy.sh` 里 pm2 restart 的注释）：

```bash
chmod +x deploy.sh
./deploy.sh
```

---

## 附录：目录结构

```
/www/wwwroot/resume-backend-node/
├── main.js                 # 启动入口
├── app.js                  # Express 应用
├── config.js               # 环境变量
├── .env                    # 敏感配置（勿提交 Git）
├── ecosystem.config.js     # PM2 配置
├── database/
│   ├── init.sql            # 建表脚本（在宝塔执行）
│   └── ops/                # 运维脚本
├── lib/
│   ├── db.js               # PostgreSQL 连接池
│   ├── pgCompat.js         # 数据库兼容层
│   ├── jwt.js              # JWT 令牌
│   └── email.js            # 邮件发送
├── services/               # 业务逻辑
├── repositories/           # 数据访问
├── routers/                # 路由
└── uploads/                # 上传文件目录
```

---

## 附录：一键命令速查

```bash
# 进入项目
cd /www/wwwroot/resume-backend-node

# 查看服务状态
pm2 status

# 查看实时日志
pm2 logs resume-backend-node --lines 50

# 重启服务
pm2 restart resume-backend-node

# 测试数据库连接
node -e "require('dotenv').config(); require('./lib/db').ping().then(()=>console.log('DB OK')).catch(e=>console.error(e.message))"

# 测试 API
curl http://127.0.0.1:8000/
```

---

> 文档版本：2026-07-11  
> 对应项目：resume-backend-node（PostgreSQL + JWT 版）
