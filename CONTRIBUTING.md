# 后端代码提交规范

本目录是独立 Git 仓库。前后端联动修改必须分别在 `resume-backend-node` 与 `resume-frontend` 创建提交，不在上级工作区执行 Git。

## 提交前检查

1. 查看已暂存、未暂存和未跟踪文件，定向审查实际差异，不覆盖其他人的改动。
2. 确认新增或改写的 JavaScript、SQL 与配置逻辑有说明用途、约束或原因的邻近中文注释。
3. 对修改的 `.js` 文件运行 `node --check`；影响范围广时运行项目快照的 `-Check full`。
4. 接口、权限、AI 任务、数据库、计费或跨层行为变化时运行项目契约检查。
5. 数据库结构变化只更新并审查唯一脚本 `database/init.sql` 与 `database/TABLES.md`；提交检查不得连接生产数据库，也不得新增迁移、重置或清理 SQL。
6. 运行 `git diff --check` 与 `git diff --cached --check`，修复空白错误后再提交。

## 提交信息

使用 `type(scope): 中文祈使短句`：

| 类型 | 用途 |
|---|---|
| `feat` | 新增业务能力或接口 |
| `fix` | 修复缺陷 |
| `perf` | 性能优化 |
| `refactor` | 不改变行为的重构 |
| `docs` | 仅文档 |
| `test` | 测试代码 |
| `build` / `ci` | 构建、依赖或流水线 |
| `chore` | 其他维护工作 |

`scope` 使用具体领域，例如 `auth`、`resume`、`ai`、`wallet`、`recharge`、`admin`、`database`、`deploy`。主题必须说明结果，不得使用“更新代码”“修改内容”或无意义编号。

示例：

```text
feat(ai): 增加视觉任务模型路由
fix(wallet): 防止充值申请重复审批
docs(database): 补充初始化脚本检查规则
```

破坏性变化使用 `type(scope)!:`，并在正文中增加 `BREAKING CHANGE:` 说明。

## 暂存与安全

- 按单一目的拆分原子提交，使用 `git add -A -- <明确文件列表>`；禁止无范围的 `git add .`。
- 不提交 `.env*`、密钥、凭据、上传内容、日志、数据库转储、`node_modules` 或可重建产物。
- 不使用 `--no-verify` 绕过提交钩子，不自动 amend、rebase 或 push。
- 输入 `--提交` 时，由 `commit-ai-resume` Skill 审查当前改动、执行验证并创建本地提交。
