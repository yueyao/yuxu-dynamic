# R-03 / R-04 / R-05 修复任务

- [x] R-03a：文本脱敏与平台诊断持久化
  - 验收：URL/秘密字段脱敏；日志、进度、失败、关闭原因不持久化秘密；不改输入。
  - 验证：`node --test test/redaction.test.ts`
  - 文件：`src/redact.ts`、`src/store.ts`、`test/redaction.test.ts`
- [x] R-03b：Worker、HTTP 与应用诊断接入
  - 验收：SDK 载荷、Worker 控制台、Web/API 错误、播客/队列错误均先脱敏。
  - 验证：脱敏回归与相关 Worker/队列测试。
- [x] R-04a：产物限额
  - 验收：全局/定义取小、实际流量限制、精确边界、拒绝无文件/索引。
  - 验证：`node --test test/limits.test.ts`
  - 文件：`src/server.ts`、`src/store.ts`、`test/limits.test.ts`
- [x] R-04b：任务/调度输入限额
  - 验收：任务、重试、调度冷/热路径统一检查 JSON 对象和 64 KiB UTF-8 限额，输出仍可大于该限制。
  - 验证：`node --test test/limits.test.ts`
- [x] R-05a：配置公共规则与核心入口
  - 验收：新别名优先、旧别名回退，API/Web 端口、bootstrap、Web 凭据和 Worker 参数一致。
  - 验证：`node --test test/env.test.ts`
- [x] R-05b：其他 Worker 与 Mac/CLI 脚本
  - 验收：演示 Worker、Mac pair/路径/Node 选择和 CLI 密码读取遵循同一规则。
  - 验证：环境变量集成测试、CLI 测试。
- [x] 完成检查与文档
  - 验收：类型/全量测试通过，文档匹配修复状态，既有工作区改动保留。
  - 验证：`npm run typecheck`、`npm test`、`git diff --check`。

完成记录（2026-11-10）：Node v24.19.0 沙箱外 `node --test test/*.test.ts`，68/68 通过，0 失败/跳过；类型检查与 `git diff --check` 退出 0。新增 19 个测试并扩展 Web 代理回归。规范第 11.1 节记录证据和边界；未自动提交或部署，未清理历史含秘密数据。
