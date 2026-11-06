# 旧仓库逻辑迁移审计

日期：2026-11-06  
状态：旧实现已从当前树移除，归档在 Git 历史/tag 中。

## 结论

旧版 `apps/`、`packages/`、`test/`、`scripts/`、`docs/`、`deploy/` 已从当前树删除。

归档位置：

- 标签：`archive/pre-taskbase-20261106`
- 分支：`archive/pre-taskbase-20261106`

当前仓库只保留：

```text
taskbase/   当前可运行工程
spec/       需求文档
```

## 已迁移到 taskbase 的能力

| 旧能力 | 新位置 | 说明 |
| --- | --- | --- |
| 所有者认证、Token | `src/store.ts`、`server.ts` | scrypt、Token、90 天 |
| App/任务定义 | `src/store.ts` | 覆盖更新、schema |
| 任务队列/租约/心跳 | `src/store.ts`、`worker-sdk.ts` | 恢复、旧 Attempt 隔离 |
| 产物 | `src/server.ts`、`store.ts` | 单产物、SHA-256 |
| 超时/关闭/重试 | `src/store.ts` | 排队/执行超时、closed |
| cron 调度 | `src/cron.ts`、`store.ts` | 重叠跳过、run-now |
| 播客列表/RSS | `src/podcast/` | 新能力 |
| Web 后台 | `web/` | 新能力 |
| 本地转写 | `src/transcription/` | Whisper CLI |
| FunASR / ElevenLabs Provider | `src/transcription/providers.ts` | 已完成契约和 mock 测试 |
| 安全下载 | `src/transcription/safe-http.ts` | HTTPS/DNS/IP/重定向/大小 |
| 切片与检查点 | `src/transcription/worker.ts` | 10 分钟切片、逐片 saveStep |
| FunASR Docker | `deploy/funasr/` | 已迁入当前工程 |

## 已废弃

| 旧能力 | 处理 |
| --- | --- |
| `apps/time-worker` / `time-cli` | 废弃；不再维护旧验证应用 |
| 旧 CLI npm 打包/发布工作流 | 废弃；改用 `install:global` + `yuxun` |
| 旧平台 `run_at` 单次延迟执行 | 不再提供；使用 cron 或手动任务 |
| 旧版 `apps/`、`packages/` | 从当前树删除，Git 历史可恢复 |

## 验证

- `npm test`：20/20 通过
- `npm run typecheck`：通过
- `taskbase` 自带 `node_modules`/devDependencies，不再依赖根目录旧环境

## 恢复旧代码

```sh
git show archive/pre-taskbase-20261106 -- <path>
# 或
git checkout archive/pre-taskbase-20261106
```

旧代码只用于查历史，不再作为运行入口。
