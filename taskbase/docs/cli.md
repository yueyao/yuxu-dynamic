# Yuxun CLI 使用文档

更新：2026-11-07
命令名：`yuxun`
定位：管理远端 Taskbase，并控制 Mac 上的转写 Worker。

## 命令总览

`yuxun` 默认只展示日常命令：

```text
yuxun login / logout
yuxun status
yuxun transcribe <audio-url>
yuxun worker <run|install|start|stop|status|logs|uninstall>
yuxun doctor
yuxun version
```

任务、调度、应用、产物属于脚本与自动化命令，默认收起：

```sh
yuxun help --all
```

命令分组：

| 分组 | 命令 | 用途 |
| --- | --- | --- |
| 日常 | `login`、`logout`、`status`、`transcribe`、`doctor`、`version` | 人手操作 |
| Worker | `worker run/install/start/stop/status/logs/doctor/pair/uninstall` | Mac 后台转写 |
| 任务 | `task run/history/get/result/events/logs/close/retry` | 脚本查询、排障 |
| 平台 | `apps`、`app register/rotate-token`、`schedule ...`、`artifact download` | 应用与调度管理 |

`yuxun <分组>` 不带参数时只打印该分组帮助，例如 `yuxun task`、`yuxun worker`。

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

```sh
yuxun version
yuxun --help
```

确认 `~/.local/bin` 在 PATH 中：

```sh
command -v yuxun
```

全局运行时只包含 CLI 与 Worker 所需文件：`src/`、`scripts/`、`package.json`、`README.md`。

## 2. 登录

```sh
export YUXUN_URL='http://43.156.253.152'
export YUXUN_PASSWORD="$(cat taskbase/.deploy/tencent-owner-password)"
yuxun login
```

Session 默认保存到：

```text
~/.config/yuxun/session.json
```

权限 600。登录 Token 有效期 90 天。

退出：

```sh
yuxun logout
```

登录后先确认整体状态：

```sh
yuxun status
```

输出示例：

```text
服务端：http://43.156.253.152
健康检查：正常（200）
登录：已登录
Worker：运行中（PID 6840）
版本：0.5.0
```

## 3. 应用与任务（高级）

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

## 4. 调度（高级）

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

## 5. 产物（高级）

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

## 7. Worker 与 macOS 后台服务

```sh
yuxun doctor
yuxun worker pair \
  --server 'http://43.156.253.152' \
  --token '<Transcription Worker Token>' \
  --provider whisper \
  --model small

yuxun worker doctor
yuxun worker install
yuxun worker start
yuxun worker stop
yuxun worker status
yuxun worker logs
yuxun worker uninstall
```

### 当前实际文件

| 项 | 路径 |
| --- | --- |
| Worker 环境 | `~/.config/yuxun/worker.env` |
| Worker 配置 | `~/.config/yuxun/worker.json` |
| 数据 | `~/Library/Application Support/Yuxun` |
| 后台服务 | `~/Library/LaunchAgents/com.yuxun.worker.plist` |
| 日志 | `~/Library/Logs/yuxun-worker.log` |

旧路径 `~/.config/taskbase/mac-agent.env` / `TaskbaseAgent` 会在 `pair/doctor/install` 时自动迁移，保留 Token 和服务地址。

### 后台服务入口

LaunchAgent 现在执行：

```text
node --env-file=~/.config/yuxun/worker.env \
  ~/.local/share/yuxun/runtime/src/cli.ts worker run
```

也就是说：

- Worker 通过 `yuxun` CLI 启动
- `yuxun worker run` 自己向服务端请求任务
- 不需要用户在命令行传音频链接

### Worker Token

在本机：

```sh
cat taskbase/.deploy/transcription-worker-token
```

Token 一旦轮换，需要重新执行 `yuxun worker pair`。

## 8. 配置与环境变量

### 当前环境变量

| 变量 | 说明 |
| --- | --- |
| `YUXUN_URL` | 远端 Platform 地址 |
| `YUXUN_PASSWORD` / `TASKBASE_PASSWORD` | 非交互登录密码 |
| `YUXUN_CONFIG_DIR` | CLI 配置目录 |
| `YUXUN_WORKER_TOKEN` | Transcription Worker Token |
| `YUXUN_DATA_DIR` | Worker 本地数据目录 |
| `YUXUN_POLL_MS` | Worker 轮询间隔 |
| `YUXUN_HEARTBEAT_MS` | Worker 心跳间隔 |

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
yuxun worker install
```

`yuxun worker install` 会重新写入后台服务并重启。

## 11. 排错

### `yuxun: command not found`

```sh
export PATH="$HOME/.local/bin:$PATH"
npm run install:global
```

### 登录失败

- 用户名 `owner`
- 密码读 `taskbase/.deploy/tencent-owner-password`
- 检查 `YUXUN_URL`（兼容旧 `TASKBASE_URL`）

### 任务一直排队

```sh
yuxun worker status
yuxun worker logs
```

检查 Worker 是否运行、Token 是否属于 `transcription-tools`。

### `whisper` / `ffmpeg` 找不到

```sh
which whisper
which ffmpeg
```

在 `~/.config/yuxun/worker.env` 设置绝对路径，例如：

```sh
TRANSCRIPTION_WHISPER_BIN=/absolute/path/to/whisper
```

### 后台服务无法启动

```sh
yuxun worker doctor
yuxun worker install
yuxun worker status
```

必要时在正常 Terminal 中执行，避免受限终端环境。

## 12. 相关文档

- [Yuxun Web 使用文档](web.md)
- [CLI 架构审计](cli-architecture.md)
- [腾讯云部署](deploy-tencent.md)
