# 旧仓库逻辑迁移审计

日期：2026-11-06  
目的：判断 `taskbase/` 新版本是否已经完整替代旧仓库逻辑，能否删除旧代码。

## 结论

**旧逻辑没有完整合并，暂时不删除旧代码。**

旧仓库 `apps/`、`packages/` 已归档在：

- 分支：`archive/pre-taskbase-20261106`
- 标签：`archive/pre-taskbase-20261106`

新代码作为独立目录 `taskbase/` 提交；旧逻辑保留，避免删除尚未迁移的能力。

## 已覆盖的部分

| 能力 | 新位置 | 说明 |
| --- | --- | --- |
| 所有者认证、Token | `taskbase/src/store.ts`、`server.ts` | scrypt、Token、90 天 |
| App/任务定义注册 | `taskbase/src/store.ts` | 覆盖更新、schema |
| 任务队列/租约/心跳 | `taskbase/src/store.ts`、`worker-sdk.ts` | 恢复、旧 Attempt 隔离 |
| 产物 | `taskbase/src/server.ts`、`store.ts` | 单产物、SHA-256 |
| 超时/关闭/重试 | `taskbase/src/store.ts` | 排队/执行超时、closed |
| cron 调度 | `taskbase/src/cron.ts`、`store.ts` | 重叠跳过、run-now |
| 播客列表/RSS | `taskbase/src/podcast/` | 新能力，旧仓库没有 |
| Web 后台 | `taskbase/web/` | 新能力，旧仓库没有 |
| 本地转写 | `taskbase/src/transcription/` | Whisper CLI；旧 FunASR 未迁移 |

## 尚未合并的旧逻辑

| 旧逻辑 | 状态 | 影响 |
| --- | --- | --- |
| `apps/podcast-tools` FunASR / ElevenLabs Provider | 未迁移 | 新版本只有 Whisper CLI |
| 安全下载 `safe-http.ts`、DNS/IP 校验 | 未迁移 | 新 Worker 只有基础 URL/协议校验 |
| 音频切片、逐片检查点、恢复 | 未迁移 | 新版本整段转写，长音频恢复较弱 |
| `apps/time-worker` / `time-cli` 时间查询 | 未迁移 | 旧验收用例 |
| CLI npm 包、发布工作流、`scripts/build-cli` | 未迁移 | 新 CLI 是源码运行 |
| `deploy/funasr` Docker/模型服务 | 未迁移 | 本地 ASR 部署仍用外部 Whisper |
| 旧平台 `run_at` 单次延迟执行 | 未在新版本实现 | 新版本只有 cron 调度 |

## 删除条件

只有满足以下条件后，才建议删除旧逻辑：

1. FunASR/ElevenLabs Provider 或明确的替代 Provider 合并进 `taskbase/src/transcription/`；
2. `safe-http` 的 SSRF/重定向/大小限制合并，或确认不再接受任意外部音频 URL；
3. 长音频切片与检查点迁移，或确认只支持单段音频；
4. 时间查询/CLI 发布等旧能力确认废弃，或迁移到新的 app；
5. 全量测试通过，包括旧仓库对应的验收用例。

在这些条件满足前，`apps/`、`packages/`、`deploy/funasr/` 保留。
