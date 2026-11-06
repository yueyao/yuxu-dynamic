# Mac Agent：把本地转写 Worker 接到远端

Mac Agent 不是一个独立任务平台；它负责把远端 Taskbase 和 Mac 上的 Transcription Worker 配对起来。

```text
远端 Taskbase（常开）
  ↑ 领取任务 / 上传产物
Mac Agent（LaunchAgent）
  └─ Transcription Worker
       └─ ffmpeg + whisper CLI
```

## 1. 准备

需要：

- macOS
- Node.js 24+
- `ffmpeg`
- `whisper` CLI（默认 `small` 模型）
- 远端 Platform 上已注册 `transcription-tools`，并取得 Worker Token

检查：

```sh
ffmpeg -version
whisper --help
```

## 2. 配对

在正常的 macOS Terminal 中运行（不要在 DSH 的沙箱终端里安装 LaunchAgent）：

```sh
cd taskbase

npm run mac:pair -- \
  --server 'http://43.156.253.152' \
  --token '<Transcription Worker Token>' \
  --provider whisper \
  --model small
```

可选 `--provider whisper|funasr|elevenlabs`。配对会写入：

- `~/.config/taskbase/mac-agent.env`（600，包含 Worker Token）
- `~/.config/taskbase/mac-agent.json`（600，不含 Token）

可选参数：

```sh
--provider whisper
--model small
--data-dir "$HOME/Library/Application Support/TaskbaseAgent"
```

FunASR / ElevenLabs 需要额外编辑 `~/.config/taskbase/mac-agent.env`：

```sh
TRANSCRIPTION_PROVIDER=funasr
FUNASR_BASE_URL=http://127.0.0.1:8000
FUNASR_API_TOKEN=...
TRANSCRIPTION_MODEL=sensevoice
```

或：

```sh
TRANSCRIPTION_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
TRANSCRIPTION_MODEL=scribe_v2
```

长音频切片：

```sh
TRANSCRIPTION_CHUNK_SECONDS=600
```

## 3. 检查

```sh
npm run mac:doctor
```

会检查：

- 配置文件
- Worker Token 是否存在
- `ffmpeg`
- `whisper`
- 远端 `/health` 或 `/api/health`
- 数据目录

## 4. 安装为登录后台服务

```sh
npm run mac:install
```

会写入：

```text
~/Library/LaunchAgents/com.taskbase.mac-agent.plist
~/Library/Logs/taskbase-agent.log
```

并执行：

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.taskbase.mac-agent.plist
```

之后：

```sh
npm run mac:start
npm run mac:stop
npm run mac:status
npm run mac:logs
npm run mac:uninstall
```

> `launchctl` 在 DSH 的沙箱进程里会被 macOS 拒绝；请在正常 Terminal 中执行 `mac:install`。

## 5. 前台调试

不安装 LaunchAgent，直接在前台跑：

```sh
npm run mac:run
```

适合第一次确认 Worker 能连接远端。

## 6. 完成一个任务

1. 远端 Web 或 CLI 创建 `transcription-tools/episode/transcribe`
2. Mac Agent 中的 Worker 领取任务
3. 下载音频
4. `ffmpeg` 转 16k 单声道 WAV
5. Whisper 转写
6. 上传 Markdown 产物
7. 远端 Web / CLI 查看/下载

CLI 示例：

```sh
npm run cli -- transcribe 'https://example.com/audio.mp3' \
  --title '测试单集' \
  --out ./transcript.md
```

## 7. 故障排查

```sh
npm run mac:doctor
npm run mac:status
npm run mac:logs
```

常见问题：

- `whisper` 不在 PATH：设置 `TRANSCRIPTION_WHISPER_BIN`，或安装到 `/usr/local/bin`、`/opt/homebrew/bin`
- 本地 HTTP 测试被拒绝：设置 `TRANSCRIPTION_ALLOW_INSECURE_HTTP=1`（仅测试，生产不要开启）
- FunASR 连接失败：检查 `FUNASR_BASE_URL` 和 `FUNASR_API_TOKEN`
- ElevenLabs 401：检查 `ELEVENLABS_API_KEY`
- `ffmpeg` 不在 PATH：安装 ffmpeg，或在 LaunchAgent 的 PATH 中包含其目录
- 401/403：Worker Token 不正确或已轮换
- 服务端 404：远端地址应指向 Web/nginx 入口，Agent 会尝试 `/health` 和 `/api/health`
- 任务一直排队：检查 Worker 是否在线、Token 是否属于 `transcription-tools`

## 8. 安全

- `mac-agent.env` 和 plist 权限为 600
- Worker Token 只保存在本机
- 远端建议使用 HTTPS
- 不要把 `.config/taskbase/mac-agent.env` 或 `.deploy/` 提交到 Git
