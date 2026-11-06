# Yuxun CLI 使用文档

更新：2026-11-06
命令名：`yuxun`
定位：管理远端 Taskbase，并控制 Mac 上的转写 Worker。

## 1. 安装形态

### 全局命令

```text
~/.local/bin/yuxun
```

它执行独立运行时：

```text
~/.local/share/yuxun/runtime/src/cli.ts
```

因此不依赖当前目录，也不依赖代码仓库路径。

### 安装/更新

```sh
cd /Users/dynamic/Documents/GitHub/yuxu-dynamic/taskbase
npm install
npm run install:global
yuxun --help
```

确认 `~/.local/bin` 在 PATH 中：

```sh
command -v yuxun
```

当前运行时还包含 Web/demo/deploy 等文件；最小包迁移见 [CLI 架构审计](cli-architecture.md)。

## 2. 登录

```sh
export TASKBASE_URL='http://43.156.253.152'
export TASKBASE_PASSWORD="$(cat taskbase/.deploy/tencent-owner-password)"
yuxun login
```

Session 默认保存到：

```text
~/.config/taskbase/session.json
```

权限 600。登录 Token 有效期 90 天。

退出：

```sh
yuxun logout
```

## 3. 应用与任务

```sh
yuxun apps list
yuxun app register <manifest.json>
yuxun app rotate-token <app-id>

yuxun task history --limit 20
yuxun task get <task-id>
yuxun task events <task-id>
yuxun task logs <task-id>
yuxun task result <task-id>
yuxun task close <task-id> --reason 'wrong input'
yuxun task retry <task-id>
```

通用提交：

```sh
yuxun task run app-id/task-key \
  --input-json '{"key":"value"}' \
  --wait \
  --timeout 3600
```

也可用 `--input <file>` 或 `--input -` 从标准输入读取 JSON。

## 4. 调度

```sh
yuxun schedule add \
  --app podcast-tools \
  --task show/sync \
  --cron '0 9 * * *' \
  --timezone Asia/Shanghai \
  --input-json '{"show_id":"show-..."}'

yuxun schedule list
yuxun schedule get <schedule-id>
yuxun schedule update <schedule-id> --enable
yuxun schedule update <schedule-id> --disable
yuxun schedule run-now <schedule-id>
yuxun schedule runs <schedule-id>
yuxun schedule remove <schedule-id>
```

## 5. 产物

```sh
yuxun artifact download <artifact-id> --out ./transcript.md
```

## 6. 转写任务：CLI 与 Worker 的分工

这是最容易混淆的一点。

完整流程图见 [一次播客转写任务全流程](diagrams/transcription-flow.png)。

### Worker 是执行端

Mac 后台的转写 Worker 会主动请求服务端：

```text
POST /v1/worker/leases
```

服务端返回任务详情，例如：

```json
{
  "audio_url": "https://...",
  "episode_id": "...",
  "title": "...",
  "language": "zh"
}
```

Worker 根据服务端下发的详情执行，**不需要用户在命令行提供音频链接**。

### `yuxun transcribe` 是手动提交

```sh
yuxun transcribe '<audio-url>' \
  --title '测试单集' \
  --language zh \
  --out ./transcript.md
```

它只负责：

1. 向 Platform 创建一个 `transcription-tools/episode/transcribe` 任务
2. 等待任务
3. 下载 Markdown 产物到本地

它不是 Worker 的启动方式。正常使用应该由 Web 创建任务，Mac Worker 自动领取。

参数：

| 参数 | 说明 |
| --- | --- |
| `--title` | 标题 |
| `--language` | `zh` / `en` / `auto` |
| `--episode-id` | 关联单集 |
| `--show-id` | 关联节目 |
| `--out` | 输出路径 |
| `--no-wait` | 只提交 |
| `--timeout` | 等待秒数 |
| `--idempotency-key` | 幂等键 |

当前限制：只接受公开 HTTP(S) URL，不支持直接上传本机音频文件。

## 7. Mac 后台服务

```sh
yuxun mac pair \
  --server 'http://43.156.253.152' \
  --token '<Transcription Worker Token>' \
  --provider whisper \
  --model small

yuxun mac doctor
yuxun mac install
yuxun mac start
yuxun mac stop
yuxun mac status
yuxun mac logs
yuxun mac uninstall
```

### 当前实际文件

| 项 | 路径 |
| --- | --- |
| Worker 环境 | `~/.config/taskbase/mac-agent.env` |
| Worker 配置 | `~/.config/taskbase/mac-agent.json` |
| 数据 | `~/Library/Application Support/TaskbaseAgent` |
| 后台服务 | `~/Library/LaunchAgents/com.yuxun.worker.plist` |
| 日志 | `~/Library/Logs/yuxun-worker.log` |

这些 `taskbase` 命名属于**未完成的迁移**，目标路径是 `~/.config/yuxun/` 和 `~/Library/Application Support/Yuxun/`。迁移方案见 [CLI 架构审计](cli-architecture.md)。

### 当前后台服务的启动方式

当前后台服务直接运行：

```text
runtime/src/transcription/worker.ts
```

即 Worker 入口。下一步会改成统一从 CLI 运行：

```text
yuxun worker run
```

在迁移完成前，使用 `yuxun mac ...` 管理。

### Worker Token

在本机：

```sh
cat taskbase/.deploy/transcription-worker-token
```

Token 一旦轮换，需要重新执行 `yuxun mac pair`。

## 8. 配置与环境变量

### 当前环境变量

| 变量 | 说明 |
| --- | --- |
| `TASKBASE_URL` | 远端 Platform 地址 |
| `TASKBASE_PASSWORD` | 非交互登录密码 |
| `TASKBASE_CONFIG_DIR` | CLI 配置目录 |
| `TASKBASE_WORKER_TOKEN` | Transcription Worker Token |
| `TASKBASE_DATA_DIR` | Worker 本地数据目录 |
| `TASKBASE_POLL_MS` | Worker 轮询间隔 |
| `TASKBASE_HEARTBEAT_MS` | Worker 心跳间隔 |

转写变量：

| 变量 | 说明 |
| --- | --- |
| `TRANSCRIPTION_PROVIDER` | `whisper` / `funasr` / `elevenlabs` |
| `TRANSCRIPTION_WHISPER_MODEL` | 默认 `small` |
| `TRANSCRIPTION_CHUNK_SECONDS` | 默认 600 |
| `TRANSCRIPTION_ALLOW_INSECURE_HTTP` | 仅本地测试 |
| `FUNASR_BASE_URL` / `FUNASR_API_TOKEN` | FunASR |
| `ELEVENLABS_API_KEY` | ElevenLabs |

### 服务端配置文件

远端服务器：

```text
/etc/taskbase/api.env
/etc/taskbase/web.env
/etc/taskbase/podcast-worker.env
```

## 9. 开发模式

在仓库内不使用全局命令时：

```sh
npm run cli -- help
npm run cli -- task history
npm run mac:status
npm run install:global
```

生产/日常建议统一使用全局 `yuxun`。

## 10. 升级

```sh
cd /Users/dynamic/Documents/GitHub/yuxu-dynamic/taskbase
git pull
npm install
npm run install:global
yuxun mac install
```

`yuxun mac install` 会重新写入后台服务并重启。

## 11. 排错

### `yuxun: command not found`

```sh
export PATH="$HOME/.local/bin:$PATH"
npm run install:global
```

### 登录失败

- 用户名 `owner`
- 密码读 `taskbase/.deploy/tencent-owner-password`
- 检查 `TASKBASE_URL`

### 任务一直排队

```sh
yuxun mac status
yuxun mac logs
```

检查 Worker 是否运行、Token 是否属于 `transcription-tools`。

### `whisper` / `ffmpeg` 找不到

```sh
which whisper
which ffmpeg
```

在 `~/.config/taskbase/mac-agent.env` 设置绝对路径，例如：

```sh
TRANSCRIPTION_WHISPER_BIN=/absolute/path/to/whisper
```

### 后台服务无法启动

```sh
yuxun mac doctor
yuxun mac install
yuxun mac status
```

必要时在正常 Terminal 中执行，避免受限终端环境。

## 12. 相关文档

- [Yuxun Web 使用文档](web.md)
- [Yuxun Mac 服务](yuxun-mac-service.md)
- [CLI 架构审计](cli-architecture.md)
- [腾讯云部署](deploy-tencent.md)
