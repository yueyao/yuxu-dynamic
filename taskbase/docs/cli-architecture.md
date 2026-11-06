# Yuxun CLI 安装与逻辑梳理

更新：2026-11-06
目标：把当前“能跑的脚本集合”收敛成一个真正的 CLI 产品。

## 1. 先纠正一个关键点

**CLI 不是执行端。**

执行端是 `worker`：

```text
Web 创建任务
      ↓
远端 Taskbase 队列
      ↓
worker 向服务端请求：有没有任务？
      ↓
服务端下发任务详情（audio_url / episode_id / title / 参数）
      ↓
worker 下载、转写、上传产物
```

当前 Worker 已经采用这个模型：

```text
POST /v1/worker/leases
```

它不需要用户在命令行里传音频链接。

当前命令：

```sh
yuxun transcribe <audio-url>
```

只是**手动提交一个任务**的管理工具，不是 Worker 的执行方式。它现在暴露在 CLI 顶层，容易让人误以为“CLI 执行任务必须给链接”。

## 2. 当前本机实际安装内容

| 项 | 当前路径 | 问题 |
| --- | --- | --- |
| 全局命令 | `~/.local/bin/yuxun` | 只是 shell 启动器 |
| 运行时 | `~/.local/share/yuxun/runtime` | 复制了 `src/web/demo/deploy` 等，不是最小包 |
| CLI 配置 | `~/.config/taskbase` | 仍叫 taskbase |
| Worker 配置 | `~/.config/taskbase/mac-agent.env` | 仍叫 taskbase / mac-agent |
| Worker 数据 | `~/Library/Application Support/TaskbaseAgent` | 仍叫 TaskbaseAgent |
| 后台服务 | `~/Library/LaunchAgents/com.yuxun.worker.plist` | 名字已改，但启动命令不是 `yuxun worker` |
| 日志 | `~/Library/Logs/yuxun-worker.log` | 已改 |
| 环境变量 | `TASKBASE_URL`、`TASKBASE_WORKER_TOKEN`、`TASKBASE_DATA_DIR` | 仍叫 TASKBASE |

### LaunchAgent 当前实际启动

```text
node --env-file=~/.config/taskbase/mac-agent.env \
  ~/.local/share/yuxun/runtime/src/transcription/worker.ts
```

也就是说：

- 后台服务绕过了 `yuxun` CLI
- CLI 和 Worker 是两套入口
- 配置/数据路径没有完成命名迁移
- 运行时包不是最小 CLI 包

## 3. 目标形态

### 3.1 单一入口

```text
yuxun
  auth
    login
    logout
  task
    submit
    list / get / result / logs
    close / retry
  schedule
    add / list / update / remove / run-now
  worker
    run
    install
    uninstall
    start / stop / status / logs
  version
  doctor
```

### 3.2 Worker 不需要链接

```sh
yuxun worker run
```

Worker 用自己的 Worker Token：

1. 请求服务端 `POST /v1/worker/leases`
2. 服务端返回任务详情
3. Worker 执行
4. 完成/失败

任务由 Web 或后台创建，不由 Worker 传 URL。

`yuxun task submit` 只作为管理/调试入口保留；转写业务的主路径是 Web → 服务端 → Worker。

### 3.3 Mac 后台服务

LaunchAgent 只负责运行：

```text
node ~/.local/share/yuxun/runtime/src/cli.ts worker run
```

不再直接运行 `transcription/worker.ts`。

这样：

- 只有 `yuxun` 一个用户入口
- CLI 能显示版本、健康检查、日志
- Worker 的启动参数、配置、路径集中管理

### 3.4 目标路径

| 项 | 目标路径 |
| --- | --- |
| 命令 | `~/.local/bin/yuxun` |
| 运行时 | `~/.local/share/yuxun/runtime` |
| CLI 配置 | `~/.config/yuxun/` |
| Worker 配置 | `~/.config/yuxun/worker.env` |
| Worker 数据 | `~/Library/Application Support/Yuxun/` |
| 后台服务 | `~/Library/LaunchAgents/com.yuxun.worker.plist` |
| 日志 | `~/Library/Logs/yuxun-worker.log` |

环境变量改为：

```text
YUXUN_URL
YUXUN_WORKER_TOKEN
YUXUN_DATA_DIR
```

迁移期保留 `TASKBASE_*` fallback，避免现有 Token/配置立即失效。

## 4. 运行时包应该包含什么

建议最小内容：

```text
runtime/
  package.json
  src/cli.ts
  src/config.ts
  src/worker-sdk.ts
  src/transcription/worker.ts
  src/transcription/asr.ts
  src/transcription/providers.ts
  src/transcription/safe-http.ts
  src/transcription/store.ts
  src/transcription/manifest.ts
  scripts/mac-agent.ts   # 迁移后可删除
  version.json
```

不放进 CLI 运行时：

- `web/`：远端 Web 才需要
- `demo/`、`deploy/`：部署示例
- `docs/screenshots/`
- `test/`
- 任何 `.data`、`.deploy`

这样包更小、边界更清楚。

## 5. 当前为什么不是“玩具”还不够

1. **两套入口**：CLI 和 Worker 各自启动。
2. **路径未统一**：yuxun 命令 + taskbase 配置/数据。
3. **安装不可升级**：`install-global` 只是复制源码，没有版本、校验、升级/卸载流程。
4. **启动器依赖绝对 Node 路径**：plist 里是 DSH 的 `.desktop-bin/node`，DSH 更新会受影响。
5. **手动 transcribe 抢占主流程**：真正的 Worker 主流程没有被 CLI 暴露。
6. **没有 `yuxun version` / `yuxun doctor`**：无法确认运行版本、配置、Token、服务端状态。
7. **没有明确的任务生产者/执行者边界**：Web 是生产者，Worker 是执行者，CLI 是管理入口；当前文档混在一起。

## 6. 改造顺序

### 第一步：Worker 收进 CLI

- 抽出 `runWorker()`，供 `yuxun worker run` 调用
- LaunchAgent 改为运行 `cli.ts worker run`
- 保留 `yuxun transcribe` 作为手动调试命令

### 第二步：路径和配置迁移

- `~/.config/taskbase` → `~/.config/yuxun`
- `TaskbaseAgent` → `Yuxun`
- `TASKBASE_*` → `YUXUN_*`，旧变量 fallback
- 自动复制旧 session/token/data，不要求重新配对

### 第三步：安装/升级/卸载

- 增加 `yuxun version`
- 增加 `yuxun doctor`
- 运行时写入版本清单
- `install-global` 增加旧版本清理、最小文件复制、Node 路径检测
- 提供 `yuxun worker uninstall --purge`

### 第四步：任务入口收敛

- Web 是转写任务的主生产者
- `yuxun worker run` 只负责领取和执行
- `yuxun transcribe <url>` 改名或明确标记为调试/手动提交
- 后续加 `yuxun task submit --episode-id`，由服务端解析音频，不传 URL

### 第五步：打包与发布

- 用 `npm pack` 或内置 release 包生成版本化 tarball
- 安装到 runtime
- 校验 SHA-256
- 支持 `yuxun version` / `yuxun upgrade`

## 7. 验收标准

完成后应满足：

1. `yuxun worker run` 不接收 URL，只向服务端请求任务。
2. Web 创建任务后，Mac 服务自动领取。
3. LaunchAgent 的 ProgramArguments 是 `cli.ts worker run`，不是 `worker.ts`。
4. `yuxun` 安装路径、配置路径、数据路径、日志路径全部使用 yuxun 命名。
5. `yuxun doctor` 能检查服务端、Token、whisper、ffmpeg、配置。
6. `yuxun version` 能显示运行时版本与构建时间。
7. 旧配置能自动迁移，不需要重新配对。
8. 运行时代码包不包含 Web/demo/deploy/screenshots/test。
9. 删除仓库目录后，全局 `yuxun worker` 仍可运行。
10. 测试覆盖 worker 入口、配置迁移和安装路径。

## 8. 结论

当前实现是“可用的原型”，不是完整的 CLI 产品。

下一步应该先做：

1. `yuxun worker run` 入口
2. 路径/环境变量迁移
3. `doctor` / `version`
4. 最小运行时包

然后再考虑删除旧逻辑。
