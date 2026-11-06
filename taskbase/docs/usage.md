# Taskbase 使用文档

更新：2026-11-06
当前版本：v0.3

## 1. 它是什么

Taskbase 是一个单用户任务平台：

```text
Web / CLI（客户端）
        ↓
远端 Taskbase Platform（任务、队列、调度、产物）
        ↓
应用 Worker（Podcast Worker / Transcription Worker）
        ↓
业务数据（播客节目、单集、转写稿）
```

当前已接入两个应用：

- `podcast-tools`：播客节目/单集列表、RSS 采集、调度
- `transcription-tools`：单集音频转写、Markdown 产物

Mac 上的 Transcription Worker 通过 Mac Agent 管理，登录后自动运行。

## 2. 当前部署

### 远端服务

```text
http://43.156.253.152/
```

- 用户名：`owner`
- 密码：本机文件 `taskbase/.deploy/tencent-owner-password`
- 公网入口：80（nginx 按 IP 路由）
- 专用端口：3410 已配置，但 Lighthouse 防火墙未放行
- 内部端口：API `3411`，Web `3412`

查看密码：

```sh
cat taskbase/.deploy/tencent-owner-password
```

### 服务器上的服务

```sh
systemctl status taskbase-api taskbase-web taskbase-podcast-worker
```

服务文件在 [`deploy/tencent/`](../deploy/tencent/)。

### 数据

- 9 个播客节目
- 95 集《知行小酒馆》
- 9 个 schedule，默认全部停用

## 3. 第一次使用

### 3.1 安装依赖并打开 Web

```sh
cd taskbase
npm install

# 安装真正的全局命令（不依赖仓库路径）
npm run install:global
taskbase --help
```

安装后会生成：

```text
~/.local/bin/taskbase
~/.local/bin/taskbase-mac-agent
~/.local/share/taskbase/runtime/
```

Mac Agent 的 LaunchAgent 也会指向这个 runtime，而不是代码仓库。

浏览器访问：

```text
http://43.156.253.152/
```

用 `owner` + 本地密码文件中的密码登录。

### 3.2 确认 Mac Agent

Mac 上：

```sh
cd /Users/dynamic/Documents/GitHub/yuxu-dynamic/taskbase
taskbase mac status
```

看到 `state = running` 即正常。

如果未运行：

```sh
taskbase mac start
```

如果还没安装：

```sh
taskbase mac doctor
taskbase mac install
```

日志：

```sh
taskbase mac logs
```

### 3.3 提交一次转写

Web：

1. 进入「节目库」
2. 打开一个节目的「单集」
3. 点击「转写」
4. 等待任务完成
5. 点击「转写稿」查看或下载 Markdown

CLI：

```sh
cd taskbase
export TASKBASE_URL='http://43.156.253.152'
export TASKBASE_PASSWORD="$(cat .deploy/tencent-owner-password)"
taskbase login

taskbase transcribe 'https://example.com/audio.mp3' \
  --title '单集标题' \
  --language zh \
  --out ./transcript.md
```

> CLI 需要公开 HTTP(S) 音频 URL；目前不支持直接上传本机音频文件。

## 4. Web 使用

### 总览

查看：

- 执行中任务
- 排队任务
- 节目数
- 已入库单集
- 最近任务
- 最近采集
- 即将触发调度

### 节目库

「添加节目」支持：

- 节目页 URL
- RSS URL（有 RSS 时优先全量入库）
- 只填节目页时回退公开页，通常只有 15 集，标记 `partial`

操作：

- **同步**：采集当前节目
- **采集两年**：按最近两年批量采集
- **单集**：查看单集，提交转写
- **调度**：为单个节目设置同步 cron
- **记录**：查看该节目采集历史

已知 RSS 来源见 [RSS 来源](rss-sources.md)。

### 调度

当前 9 个节目各有一个 schedule，默认停用。

启用后：

- 按 cron 触发 `show/sync`
- 同一 schedule 有未结束任务时跳过
- Mac 睡眠/平台停机期间错过的触发不补跑
- 需要补数据时用「run-now」或手动同步

### 采集任务

查看：

- `show/sync` / `shows/collect` 任务
- 状态、进度、产物
- 任务事件和日志

### 应用

查看已注册 App、任务定义和 Worker Token。

- Podcast Worker Token 只显示一次
- 丢失后可在应用页轮换
- 转写应用未注册时，节目库会显示注册按钮

## 5. CLI 使用

所有命令：

```sh
cd taskbase
taskbase help
```

### 登录

```sh
export TASKBASE_URL='http://43.156.253.152'
export TASKBASE_PASSWORD="$(cat .deploy/tencent-owner-password)"
taskbase login
```

Session 默认保存在 `~/.config/taskbase/session.json`，权限 600。

### 应用与任务

```sh
taskbase apps list
taskbase task history --limit 20
taskbase task get <task-id>
taskbase task events <task-id>
taskbase task logs <task-id>
taskbase task result <task-id>
taskbase task close <task-id> --reason 'wrong input'
taskbase task retry <task-id>
```

### 转写

```sh
taskbase transcribe '<audio-url>' \
  --title '标题' \
  --language zh \
  --out ./transcript.md
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--title` | 转写稿标题 |
| `--language` | `zh` / `en` / `auto` |
| `--episode-id` | 关联单集 ID |
| `--show-id` | 关联节目 ID |
| `--out` | Markdown 输出路径 |
| `--no-wait` | 只提交，不等待 |
| `--timeout` | 等待秒数，默认 21600 |
| `--idempotency-key` | 幂等键 |

任务成功后会：

1. 从平台下载产物
2. 写入本地 Markdown
3. 打印保存路径

### 产物

```sh
taskbase artifact download <artifact-id> --out ./transcript.md
```

## 6. Mac Agent

Mac Agent 是 LaunchAgent 管理的 Transcription Worker，不是独立任务平台。

### 当前配置

| 项 | 路径 |
| --- | --- |
| 环境文件 | `~/.config/taskbase/mac-agent.env` |
| 配置 | `~/.config/taskbase/mac-agent.json` |
| LaunchAgent | `~/Library/LaunchAgents/com.taskbase.mac-agent.plist` |
| 日志 | `~/Library/Logs/taskbase-agent.log` |
| 数据目录 | `~/Library/Application Support/TaskbaseAgent` |

### 配对

Worker Token 在：

```sh
cat taskbase/.deploy/transcription-worker-token
```

重新配对：

```sh
taskbase mac pair \
  --server 'http://43.156.253.152' \
  --token '<Transcription Worker Token>' \
  --provider whisper \
  --model small
```

### 检查

```sh
taskbase mac doctor
```

会检查：

- 配置和 Token
- `ffmpeg`
- `whisper`
- 远端 `/health` 或 `/api/health`
- 数据目录

### 安装、启停、日志

```sh
taskbase mac install
taskbase mac start
taskbase mac stop
taskbase mac status
taskbase mac logs
```

卸载（保留配置）：

```sh
taskbase mac uninstall
```

卸载并清除配置：

```sh
taskbase mac uninstall -- --purge
```

### Provider

`~/.config/taskbase/mac-agent.env` 支持：

```sh
TRANSCRIPTION_PROVIDER=whisper
TRANSCRIPTION_WHISPER_MODEL=small
```

或：

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

修改后重启：

```sh
taskbase mac stop
taskbase mac start
```

## 7. 转写内部流程

```text
提交任务
  → 下载音频
  → ffmpeg 转 16k 单声道 WAV
  → 按 TRANSCRIPTION_CHUNK_SECONDS 切片，默认 600 秒
  → 逐片 ASR
  → 每片 saveStep 检查点
  → 合并 segments + 时间戳
  → 上传 transcript.md
  → complete
```

### Provider

- `whisper`：本机 Whisper CLI，默认 `small`
- `funasr`：自托管 FunASR OpenAI-compatible API
- `elevenlabs`：ElevenLabs STT

### 安全下载

默认：

- 只允许 HTTPS
- 拒绝私网、loopback、保留地址
- DNS 固定 IP，防 DNS 重绑定
- 重定向校验
- 最大 500 MiB

本机测试可以临时设置：

```sh
TRANSCRIPTION_ALLOW_INSECURE_HTTP=1
```

生产不要开启。

### 检查点

每片转写完成后写入平台 `task_steps`：

```text
asr-chunk-0
asr-chunk-1
...
```

重试或 Worker 恢复时复用已完成切片，避免重复转写。

## 8. 服务器运维

### 服务

```sh
systemctl status taskbase-api taskbase-web taskbase-podcast-worker
systemctl restart taskbase-api taskbase-web taskbase-podcast-worker
```

### 日志

```sh
journalctl -u taskbase-api -f
journalctl -u taskbase-web -f
journalctl -u taskbase-podcast-worker -f
```

### 健康检查

```sh
curl http://127.0.0.1:3411/health
curl http://127.0.0.1:3412/api/health
curl -H 'Host: 43.156.253.152' http://127.0.0.1/api/health
```

### 数据

```text
/var/lib/taskbase/taskbase.sqlite
/var/lib/taskbase/artifacts/
```

备份时不要只复制正在写入的主库；WAL 模式下同时处理 `-wal`/`-shm`，或在低峰停服务后用 `sqlite3 .backup`。

## 9. 常见问题

### Web 打不开

- 确认 `http://43.156.253.152/` 可访问
- 检查 nginx 和 `taskbase-web`
- 3410 未放行时不要使用 `:3410`

### 登录失败

- 用户名必须是 `owner`
- 密码读 `taskbase/.deploy/tencent-owner-password`
- 登录失败过多会短时限流

### 任务一直 queued

- 检查 Mac Agent：`taskbase mac status`
- 检查日志：`taskbase mac logs`
- 检查 Worker Token 是否属于 `transcription-tools`

### 转写 401/403

重新轮换 Token 并重新配对：

```sh
taskbase mac uninstall
taskbase mac pair --server ... --token ...
taskbase mac install
```

### whisper 找不到

```sh
which whisper
whisper --help
```

或在 `mac-agent.env` 设置：

```sh
TRANSCRIPTION_WHISPER_BIN=/absolute/path/to/whisper
```

### HTTP 音频被拒绝

这是安全策略。生产使用 HTTPS；只有本机测试才设置：

```sh
TRANSCRIPTION_ALLOW_INSECURE_HTTP=1
```

### Mac 睡眠后任务失败

Mac 睡眠期间 Worker 无法心跳，租约可能过期。醒来后会进入恢复流程；已完成的切片检查点会被复用。

## 10. 安全与备份

- 公网入口目前是 HTTP，没有 TLS；建议后续配置 HTTPS 或 Tailscale
- `.deploy/`、`~/.config/taskbase/mac-agent.env` 不要提交 Git
- Owner 密码和 Worker Token 分开保存
- 定期备份 SQLite 和 artifacts
- 不要把 `/etc/taskbase/*.env` 或 Token 发到公开渠道

## 11. 当前限制

- 本机音频文件不能直接上传；CLI 只接受公开 URL
- 转写暂无重叠切片/VAD 边界
- 时间查询旧任务和旧 CLI npm 打包尚未迁移
- 旧仓库逻辑仍保留，暂未删除

## 12. 相关文档

- [README](../README.md)
- [Mac Agent](mac-agent.md)
- [架构](architecture.md)
- [腾讯云部署](deploy-tencent.md)
- [RSS 来源](rss-sources.md)
- [旧逻辑迁移审计](legacy-migration-audit.md)
- [远端转写方案](remote-transcription-architecture.md)
