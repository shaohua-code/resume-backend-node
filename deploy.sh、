#!/bin/bash

LOG="/www/wwwroot/deploy_log.txt"

echo "==================== 部署开始 $(date) ====================" >> $LOG

# 进入目录
cd /www/wwwroot/resume-backend-node || {
  echo "目录不存在！" >> $LOG
  exit 1
}

# 拉取代码
echo "拉取代码..." >> $LOG
git pull origin main >> $LOG 2>&1

# 判断 git 是否成功
if [ $? -ne 0 ]; then
  echo "git pull 失败，终止部署" >> $LOG
  exit 1
fi

# 安装依赖（可选优化：只在 package.json 变化时执行）
echo "安装依赖..." >> $LOG
npm install >> $LOG 2>&1

# PM2 处理
echo "重启服务..." >> $LOG

pm2 describe resume-api > /dev/null
if [ $? -eq 0 ]; then
    pm2 restart resume-api >> $LOG 2>&1
else
    pm2 start app.js --name resume-api >> $LOG 2>&1
fi

echo "==================== 部署完成 $(date) ====================" >> $LOG