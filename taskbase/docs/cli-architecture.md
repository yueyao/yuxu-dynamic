# Yuxun CLI 架构

更新：2026-11-06  
这是架构说明，不是日常操作手册；日常命令见 [Yuxun CLI 使用文档](cli.md)。

## 1. 边界

```text
Web / CLI（管理入口）
        ↓
远端 Taskbase（任务、队列、调度、产物）
        ↓
Yuxun Worker（Mac 执行端）
        ↓
音频下载 → ffmpeg → 切片 → ASR → Markdown
```

- Web 是转写任务的主要生产者。
- CLI 是管理入口，也可以手动提交任务。
- Worker 是执行端；它通过 `POST /v1/worker/leases` 向服务端请求任务，**不需要用户传音频链接**。

## 2. 单一入口

```text
yuxun
  login / logout
  task ...
  schedule ...
  worker run
  worker pair / doctor / install / start / stop / status / logs / uninstall
  doctor
  version
  transcribe <url>   # 手动提交，不是 Worker 主流程
```

`yuxun worker run` 直接调用 `src/transcription/worker.ts` 的 `runTranscriptionWorker()`，不会启动第二个 CLI。

## 3. 本机安装

| 项 | 路径 |
| --- | --- |
| 命令 | `~/.local/bin/yuxun` |
| 运行时 | `~/.local/share/yuxun/runtime` |
| CLI 配置 | `~/.config/yuxun/` |
| Worker 环境 | `~/.config/yuxun/worker.env` |
| Worker 配置 | `~/.config/yuxun/worker.json` |
| Worker 数据 | `~/Library/Application Support/Yuxun/` |
| 后台服务 | `~/Library/LaunchAgents/com.yuxun.worker.plist` |
| 日志 | `~/Library/Logs/yuxun-worker.log` |

后台服务执行：

```text
node --env-file=~/.config/yuxun/worker.env \
  ~/.local/share/yuxun/runtime/src/cli.ts worker run
```

旧路径 `~/.config/taskbase`、`TaskbaseAgent`、`TASKBASE_*` 由 `pair/doctor/install` 自动迁移，旧变量继续作为 fallback。

## 4. 运行时包

```text
runtime/
  package.json
  README.md
  src/
  scripts/
```

不再复制 `web/`、`demo/`、`deploy/`、`test/`、截图、`.data`、`.deploy`。

## 5. 任务流程

```text
Web POST /api/podcast/episodes/:id/transcribe
  → Platform 创建 queued task
  → Worker POST /v1/worker/leases
  → Platform 下发任务详情
  → 安全下载 → ffmpeg → 切片 → 逐片 ASR
  → saveStep → 合并 → 上传 transcript.md
  → complete
  → Web 读取 transcript 并渲染 Markdown
```

完整时序图：[transcription-flow.png](diagrams/transcription-flow.png)。

## 6. 当前限制

- `yuxun transcribe <url>` 仍保留为手动提交工具，不承担 Worker 主流程。
- 安装是自定义 runtime 安装，不是 npm 全局包；Node 24 不接受 `node_modules` 内的 `.ts`，所以采用独立 runtime。
- 升级目前需要重新执行 `npm run install:global`，暂无自动升级命令。
- plist 使用当前 Node 的绝对路径；DSH 更新后可能需要重装服务。

## 7. 验收

- `yuxun version`、`yuxun doctor`、`yuxun status` 可用
- 默认帮助只展示日常命令，`yuxun help --all` 展示全部
- LaunchAgent 执行 `cli.ts worker run`
- Web 创建任务后 Worker 自动领取
- 旧配置自动迁移
- 运行时不含 Web/demo/deploy
- 测试通过，Worker 入口不依赖 URL
