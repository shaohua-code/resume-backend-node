# AI 简历助手 — Ubuntu 22 纯命令行部署指南（无宝塔）

> 适用：全新 Ubuntu 22.04 云服务器，全程 SSH + 命令行，不依赖宝塔面板  
> 技术栈：PostgreSQL + Node.js + PM2 + Nginx + JWT + 邮箱验证码

---

## 目录

1. [整体架构](#1-整体架构)
2. [登录服务器与安全组](#2-登录服务器与安全组)
3. [安装 PostgreSQL](#3-安装-postgresql)
4. [创建数据库并执行建表 SQL](#4-创建数据库并执行建表-sql)
5. [安装 Node.js](#5-安装-nodejs)
6. [部署后端代码](#6-部署后端代码)
7. [配置 .env](#7-配置-env)
8. [PM2 守护进程](#8-pm2-守护进程)
9. [安装 Nginx 反向代理](#9-安装-nginx-反向代理)
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
Nginx (:80 / :443)
    ├── /          → 前端静态文件 (Vue3 dist)
    └── /api/*     → Node.js Express (PM2, :8000)
                           │
                           ├── PostgreSQL (127.0.0.1:5432, ai_resume)
                           ├── 163 SMTP (验证码邮件)
                           └── DeepSeek API
```

**你的服务器信息：**

| 项 | 值 |
|----|-----|
| 公网 IP | `175.178.62.55` |
| 系统 | Ubuntu 22.04 |
| 数据库名 | `ai_resume` |
| 数据库用户 | `ai_resume` |
| 后端端口 | `8000`（仅本机，不对公网开放） |

---

## 2. 登录服务器与安全组

### 2.1 SSH 登录

本机 PowerShell：

```powershell
ssh root@175.178.62.55
```

Ubuntu 默认用户可能是 `ubuntu`：

```powershell
ssh ubuntu@175.178.62.55
```

### 2.2 更新系统

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git unzip
```

### 2.3 腾讯云安全组

控制台 → 云服务器 → 安全组 → 入站规则：

| 端口 | 协议 | 来源 | 说明 |
|------|------|------|------|
| 22 | TCP | 你的 IP | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP |
| 443 | TCP | 0.0.0.0/0 | HTTPS |

**不要开放 5432、8000 到公网。**

### 2.4 系统防火墙（可选）

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

---

## 3. 安装 PostgreSQL

### 3.1 安装 PostgreSQL 14

```bash
sudo apt install -y postgresql postgresql-contrib
```

查看版本与状态：

```bash
psql --version
sudo systemctl status postgresql
sudo systemctl enable postgresql
```

### 3.2 创建数据库用户和库

切换到 postgres 系统用户：

```bash
sudo -u postgres psql
```

在 `psql` 里执行（**把密码换成你的**）：

```sql
CREATE USER "ai_resume" WITH PASSWORD 'sss980318..';
CREATE DATABASE "ai_resume" OWNER "ai_resume";
GRANT ALL PRIVILEGES ON DATABASE "ai_resume" TO "ai_resume";
\q
```

> 库名和用户名含连字符，SQL 里必须用双引号。

### 3.3 验证能否登录

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume
```

输入密码后能进入 `ai_resume=#` 提示符即成功，输入 `\q` 退出。

---

## 4. 创建数据库并执行建表 SQL

### 4.1 上传 init.sql 到服务器

**方式 A：本机 scp 上传**

在本机 PowerShell：

```powershell
scp "d:\project\新建文件夹\resume-backend-node\database\init.sql" root@175.178.62.55:/tmp/init.sql
```

**方式 B：服务器上用 nano 粘贴**

```bash
nano /tmp/init.sql
# 粘贴 database/init.sql 全文，Ctrl+O 保存，Ctrl+X 退出
```

### 4.2 执行建表脚本

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume -f /tmp/init.sql
```

### 4.3 验证（应有 20 张表）

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

预期输出：`20`

查看表名：

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
```

应包含：`users`、`user_profile`、`resume`、`otp_codes`、`ai_model` 等。

---

## 5. 安装 Node.js

### 5.1 安装 Node 18 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # v18.x
npm -v
```

### 5.2 安装 PM2

```bash
sudo npm install -g pm2
```

---

## 6. 部署后端代码

### 6.1 创建项目目录

```bash
sudo mkdir -p /var/www/resume-backend-node
sudo chown -R $USER:$USER /var/www
```

### 6.2 上传代码

**方式 A：Git 克隆**

```bash
cd /var/www
git clone https://你的仓库地址/resume-backend-node.git
cd resume-backend-node
```

**方式 B：本机 scp 整个项目**

```powershell
scp -r "d:\project\新建文件夹\resume-backend-node" root@175.178.62.55:/var/www/
```

服务器上：

```bash
cd /var/www/resume-backend-node
```

### 6.2.1 确认代码已是 PostgreSQL 版本（必做）

上传后**先检查**，再 `npm install`。若仍是旧 Supabase 代码，启动会报 `supabaseUrl is required`。

```bash
cd /var/www/resume-backend-node

# 新代码：约 10 行，含 pgAdmin，不含 createClient
wc -l supabaseClient.js
head -5 supabaseClient.js

# 以下任一有输出 = 旧代码，需重新上传本地最新代码
grep -n 'createClient' supabaseClient.js
grep '@supabase/supabase-js' package.json
ls lib/db.js lib/pgCompat.js 2>/dev/null || echo '缺少 lib/ 目录，需重新上传'
```

**正确**的 `supabaseClient.js` 开头应类似：

```javascript
const { pgAdmin } = require('./lib/pgCompat')
const supabaseAdmin = pgAdmin
module.exports = { supabaseAdmin, pgAdmin }
```

若仍是旧版，在**本机 Windows** 重新覆盖上传（注意路径）：

```powershell
scp -r "d:\project\新建文件夹\resume-backend-node\*" root@175.178.62.55:/var/www/resume-backend-node/
```

### 6.3 安装依赖

```bash
cd /var/www/resume-backend-node
rm -rf node_modules
npm install --production

# 确认已无 Supabase 包
ls node_modules/@supabase 2>/dev/null && echo '仍有旧依赖，检查 package.json' || echo 'OK：无 Supabase'
```

### 6.4 创建上传目录

```bash
mkdir -p uploads
chmod 755 uploads
```

---

## 7. 配置 .env

```bash
nano /var/www/resume-backend-node/.env
```

写入（**按实际修改**）：

```env
# PostgreSQL（同机必须用 127.0.0.1）
DATABASE_URL=postgresql://ai_resume:sss980318..@127.0.0.1:5432/ai_resume

# JWT
JWT_SECRET=请替换为至少32位随机字符串
JWT_ACCESS_EXPIRES=1h
JWT_REFRESH_EXPIRES=7d

# 163 邮箱 SMTP
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=shaohua_code@163.com
SMTP_PASS=你的163授权码
SMTP_FROM=shaohua_code@163.com

# 服务
PORT=8000

# DeepSeek
DEEPSEEK_API_KEY=你的DeepSeek密钥
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions

# 跨域（填你的前端地址）
CORS_ORIGINS=http://localhost:5173,http://175.178.62.55

# 前端地址
APP_FRONTEND_URL=http://175.178.62.55
```

### 测试启动

```bash
cd /var/www/resume-backend-node

# 先单独测数据库客户端，避免整服务启动才报错
node -e "require('./supabaseClient'); console.log('supabaseClient OK')"

node main.js
```

看到 `[服务] 已启动: http://localhost:8000` 即成功。`Ctrl+C` 停止，下一步用 PM2。

### 常见错误：`supabaseUrl is required`

**原因**：服务器代码仍是 Supabase 旧版（`supabaseClient.js` 第 29 行 `createClient`），与已去掉 `SUPABASE_URL` 的 `.env` 冲突。

**一键修复**（SSH 在服务器执行）：

```bash
cd /var/www/resume-backend-node
grep -q 'createClient' supabaseClient.js && echo '❌ 仍是旧代码，请在本机 scp 上传最新代码' || echo '✅ supabaseClient 已是 pg 版本'
rm -rf node_modules
npm install --production
node -e "require('./supabaseClient'); console.log('OK')"
node main.js
```

若第一步显示「仍是旧代码」，必须在本地重新 `scp` 整个项目后再执行后续命令。

### 测试数据库连接

```bash
node -e "require('dotenv').config(); require('./lib/db').ping().then(()=>console.log('DB OK')).catch(e=>console.error('DB FAIL:', e.message))"
```

应输出 `DB OK`。

---

## 8. PM2 守护进程

### 8.1 创建 PM2 配置

```bash
nano /var/www/resume-backend-node/ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'resume-backend-node',
    script: 'main.js',
    cwd: '/var/www/resume-backend-node',
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

### 8.2 启动

```bash
cd /var/www/resume-backend-node
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 startup` 会输出一行 `sudo env PATH=...` 命令，**复制执行它**。

### 8.3 常用命令

```bash
pm2 status
pm2 logs resume-backend-node --lines 50
pm2 restart resume-backend-node
```

### 8.4 测试 API

```bash
curl http://127.0.0.1:8000/
```

有 JSON 响应即正常。

---

## 9. 安装 Nginx 反向代理

### 9.1 安装 Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

浏览器访问 `http://175.178.62.55` 应看到 Nginx 默认页。

### 9.2 创建站点配置

```bash
sudo nano /etc/nginx/sites-available/resume
```

写入：

```nginx
server {
    listen 80;
    server_name 175.178.62.55;   # 有域名就改成你的域名

    client_max_body_size 20m;

    # 前端静态文件（后面部署前端时启用）
    root /var/www/resume-frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

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

    # 上传文件
    location /uploads {
        proxy_pass http://127.0.0.1:8000;
    }
}
```

> 若暂时只部署后端、不部署前端，可先把 `root` 和 `location /` 改成只返回 API 说明，或临时注释前端部分。

**仅后端、暂不部署前端时的精简版：**

```bash
sudo nano /etc/nginx/sites-available/resume
```

```nginx
server {
    listen 80;
    server_name 175.178.62.55;

    client_max_body_size 20m;

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }

    location /uploads {
        proxy_pass http://127.0.0.1:8000;
    }

    location / {
        return 200 'resume API is running';
        add_header Content-Type text/plain;
    }
}
```

### 9.3 启用站点

```bash
sudo ln -sf /etc/nginx/sites-available/resume /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 9.4 测试外网 API

```bash
curl http://175.178.62.55/api/
```

或在浏览器打开 `http://175.178.62.55/api/`。

### 9.5 HTTPS（有域名时）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名.com
```

---

## 10. 部署前端（可选）

### 10.1 本地构建

在本机 PowerShell：

```powershell
cd "d:\project\新建文件夹\resume-frontend"
```

编辑 `.env.production`：

```env
VITE_API_URL=http://175.178.62.55
```

构建：

```powershell
npm run build
```

### 10.2 上传到服务器

```powershell
scp -r "d:\project\新建文件夹\resume-frontend\dist" root@175.178.62.55:/var/www/resume-frontend/
```

### 10.3 确认 Nginx 指向前端

Nginx 配置里应有：

```nginx
root /var/www/resume-frontend/dist;
```

重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 10.4 本地开发时连远程 API

前端本地 `npm run dev` 时，改 `vite.config.js` 代理或 `.env.development`：

```env
VITE_API_URL=http://175.178.62.55
```

---

## 11. 创建超级管理员

### 11.1 先在前端注册一个账号

访问 `http://175.178.62.55`，完成注册和登录。

### 11.2 SQL 提升为超管

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume
```

```sql
UPDATE public.user_profile
SET role = 'SUPER_ADMIN', status = 'ACTIVE', update_time = now()
WHERE email = '你的注册邮箱@163.com';

INSERT INTO public.admin_quota_pool (admin_id, total_quota, allocated_quota, update_time)
SELECT user_id, 1000000, 0, now()
FROM public.user_profile
WHERE email = '你的注册邮箱@163.com'
ON CONFLICT (admin_id) DO NOTHING;
```

```sql
\q
```

重新登录后应能进入管理后台。

---

## 12. 验证清单

```
□ 1. SSH 能登录
□ 2. PostgreSQL 运行中：sudo systemctl status postgresql
□ 3. 数据库 ai_resume 已创建
□ 4. init.sql 已执行，表数量 = 20
□ 5. 代码在 /var/www/resume-backend-node
□ 6. .env 中 DATABASE_URL 用 127.0.0.1
□ 7. pm2 status 显示 online
□ 8. curl http://127.0.0.1:8000/ 有响应
□ 9. curl http://175.178.62.55/api/ 外网可访问
□ 10. 能发验证码、注册、登录
□ 11. 超管 SQL 已执行
□ 12. AI 生成简历正常
```

---

## 13. 常见问题

### Q1: `psql: error: connection refused`

```bash
sudo systemctl start postgresql
sudo systemctl status postgresql
```

### Q2: `password authentication failed`

检查创建用户时的密码是否与 `.env` 里 `DATABASE_URL` 一致。

### Q3: `relation "users" does not exist`

未执行 `init.sql`：

```bash
psql -h 127.0.0.1 -U ai_resume -d ai_resume -f /tmp/init.sql
```

### Q4: `DB FAIL: Connection terminated unexpectedly`

`.env` 必须用 `127.0.0.1`，不要用公网 IP：

```env
DATABASE_URL=postgresql://ai_resume:密码@127.0.0.1:5432/ai_resume
```

### Q5: 验证码收不到

```bash
pm2 logs resume-backend-node --lines 30
```

- 检查 163 授权码是否正确
- 未配 SMTP 时，验证码会打在日志里

### Q6: 前端 CORS 报错

`.env` 加上前端地址：

```env
CORS_ORIGINS=http://175.178.62.55,http://localhost:5173
```

然后：

```bash
pm2 restart resume-backend-node
```

### Q7: Nginx 502 Bad Gateway

后端没起来：

```bash
pm2 status
pm2 logs resume-backend-node
curl http://127.0.0.1:8000/
```

### Q8: 更新代码后重新部署

```bash
cd /var/www/resume-backend-node
git pull origin main          # 若用 Git
npm install --production
pm2 restart resume-backend-node
```

---

## 附录：一键命令速查

```bash
# 进入项目
cd /var/www/resume-backend-node

# 服务状态
pm2 status
sudo systemctl status postgresql
sudo systemctl status nginx

# 日志
pm2 logs resume-backend-node --lines 50

# 重启
pm2 restart resume-backend-node
sudo systemctl reload nginx

# 数据库
psql -h 127.0.0.1 -U ai_resume -d ai_resume

# 测试
curl http://127.0.0.1:8000/
curl http://175.178.62.55/api/
```

---

## 附录：目录结构（服务器）

```
/var/www/
├── resume-backend-node/     # 后端
│   ├── main.js
│   ├── .env
│   ├── ecosystem.config.js
│   ├── database/init.sql
│   ├── lib/
│   ├── uploads/
│   └── ...
└── resume-frontend/         # 前端（可选）
    └── dist/
        ├── index.html
        └── assets/
```

---

> 文档版本：2026-07-11  
> 无宝塔，纯 Ubuntu 22 + apt + PM2 + Nginx
