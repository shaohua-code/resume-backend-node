# 浏览器扩展发布包

当前官网稳定下载接口：`GET /api/extension/download`。

发布 V2.0.0 时，将包含 `dist/` 根目录的压缩包放到这里，并保持文件名：

```text
ai-resume-extension-v2.0.0.zip
```

ZIP 属于构建产物，已被 Git 忽略。部署时可手工上传到该目录，或通过发布脚本生成。
