# Taskbase 底座 v0.2 + 播客 Web + 本地转写

独立的个人任务平台工程，和现有 `yuxu-dynamic` 仓库代码无关。

当前包含三层：

- **底座**：任务队列、租约、恢复、超时、关闭/重试、产物、cron 调度
- **播客应用**：`podcast_` 前缀表、小宇宙公开页解析、**RSS 解析**、两年范围列表采集、Podcast Worker
- **Web 端**：平台管理后台 + 播客任务后台

> 说明：这里按前文语境实现的是**播客（Podcast）**任务后台；如果你说的“博客”是 Blog 发布系统，需要另做领域层，当前 `podcast_` 模型不适用。

## 技术栈

- **运行时**：Node.js 24（直接运行 TypeScript，无构建步骤）
- **语言**：TypeScript，依赖 Node 内置类型剥离
- **HTTP**：Node 内置 `node:http`
- **数据库**：Node 内置 `node:sqlite`（SQLite，WAL）
- **认证/加密**：Node 内置 `node:crypto`（scrypt、SHA-256、随机 Token）
- **Web 前端**：原生 HTML/CSS/JavaScript，无 React/Vue、无打包器
- **Web 后端**：自写 Session/Cookie/CSRF、平台 API 代理、静态资源服务
- **CLI**：自写命令解析 + `fetch`
- **调度**：自写 5 字段 cron 解析与下次触发计算，无第三方 cron 库
- **Schema**：自写受控 JSON Schema 子集校验器
- **RSS/XML**：`fast-xml-parser`（服务端依赖，用于 RSS/Atom）
- **测试**：Node 内置 `node:test`
- **运行时依赖**：服务端 1 个（`fast-xml-parser`），其余 0 个
- 文档截图使用 Pillow / Playwright 生成，不属于运行依赖

## 当前能力

### 底座

- 单用户 bootstrap + 登录；用户 Token 与 Worker Token 隔离
- 应用注册与任务定义覆盖更新；无版本/快照
- 任务：提交、排队、领取、心跳、进度、日志、检查点、完成/失败
- 租约恢复；排队/执行超时；人工关闭；失败/关闭后重试
- 产物上传/下载与 SHA-256 校验
- **cron 调度**：每个 schedule 独立 cron/时区/输入；重叠跳过、漏跑跳过、run-now、启停、运行历史

### Web 端

- **平台管理后台**：总览、任务详情、应用注册/任务定义/Token 轮换、调度管理
- **播客任务后台**：节目库、添加节目、同步、两年范围采集、单集列表、采集记录、每节目 schedule
- 浏览器只拿 HttpOnly Session Cookie；平台 Owner Token 不进浏览器
- CSRF 校验；Web 端平台代理；CSP 禁止内联脚本
- 单用户 Session 保存在 Web Server 内存，重启后重新登录

### 播客应用

- 小宇宙公开节目页 `__NEXT_DATA__` 解析
- 节目/单集列表入库；**不下载音频**
- 支持 RSS/Atom；有 RSS 时按 RSS 完整历史入库
- 没有 RSS 时回退公开页，通常只有 15 集，标记 `partial`
- `podcast_shows` / `podcast_episodes` / `podcast_ingest_runs` 由应用自迁移
- `show/sync` 可调度；`shows/collect` 用于批量采集

### 转写应用

- 独立 app：`transcription-tools`，任务 `episode/transcribe`
- 本地 Whisper CLI（默认 `small`）；支持 FunASR / ElevenLabs Provider
- 下载音频 → ffmpeg 16k 单声道 → ASR → Markdown 产物
- 产物上传回远端平台 API；文字稿写入 `transcription_transcripts`
- Web 单集列表可直接“转写”，并查看转写稿/下载 Markdown
- 安全下载：默认只允许 HTTPS，拒绝私网/保留地址；本地测试可显式允许 HTTP
- 临时音频默认删除；单产物上限 5 MiB

**尚未包含**：RSS 自动发现 UI、拉取→转写自动串联、文章→Markdown、平台 `app_state`、多产物/大二进制、多用户权限、Blog 发布领域。

## 环境要求

- Node.js 24+
- 服务端 RSS 解析依赖：`fast-xml-parser`
- 转写需要本机 `ffmpeg` 与 `whisper` CLI（默认 `small` 模型）

## 快速开始

```sh
cd taskbase
npm install

# 1. 初始化所有者
export TASKBASE_OWNER_PASSWORD='change-me-to-a-long-password'
npm run bootstrap

# 2. 启动平台 API（默认 127.0.0.1:3333）
npm run server

# 3. 启动 Web 端（默认 127.0.0.1:3334）
npm run web
# 浏览器打开 http://127.0.0.1:3334，用 owner + 密码登录

# 4. 在 Web「节目库」点击“注册播客应用”，保存一次性 Worker Token
export TASKBASE_WORKER_TOKEN='<Worker Token>'
npm run worker:podcast

# 5. 在 Web 节目库添加节目：
#    - 填节目页链接 + RSS 链接（有 RSS 时优先全量入库）
#    - 或只填节目页链接，回退公开页（通常只有 15 集，标 partial）
#    然后点击“同步”或“采集两年”

# 6. 在 Web「节目库」点击“注册转写应用”，保存转写 Worker Token
export TASKBASE_WORKER_TOKEN='<转写 Worker Token>'
npm run worker:transcription

# 7. 打开节目单集 → “转写”，完成后点“转写稿”查看/下载 Markdown
```

CLI 仍可用：

```sh
export TASKBASE_URL='http://127.0.0.1:3333'
export TASKBASE_PASSWORD='change-me-to-a-long-password'
npm run cli -- login
npm run cli -- apps list
npm run cli -- task history --limit 20
```

## Web 页面与截图

截图文件较大，未纳入 Git；本地保留在 `docs/screenshots/`，用于说明 Web 页面和部署效果。

## 音频转写调研

[音频转写能力调研报告](docs/transcription-research.md)：对比本地 FunASR/SenseVoice、faster-whisper、腾讯云、阿里云和 OpenAI 方案。当前已落地 **Whisper CLI 本地 Provider**；FunASR/MLX/云端 Provider 仍可替换。

## RSS 来源

[RSS 来源与首批栏目](docs/rss-sources.md)：已通过 Apple Podcasts 搜索找到 9 个中文栏目 feed，并实测《忽左忽右》入库 203 集。Podcast Index 可作为后续补充发现层。

## CLI 与转写

CLI 是转写任务的**客户端**，不替代服务端 Worker：

- CLI 负责提交 `transcription-tools/episode/transcribe`、等待、下载 Markdown
- 实际 ASR 仍由本机 Transcription Worker 执行
- 输入必须是公开 HTTP(S) 音频 URL；本机音频文件暂不支持直接上传
- 默认等待 6 小时；`--no-wait` 只提交
- 任务会出现在 Web「采集任务」中

## Mac Agent（本地转写 Worker）

Mac Agent 把远端 Taskbase 和本机 Whisper Worker 配对起来，登录后可通过 LaunchAgent 后台运行：

```sh
npm run mac:pair -- --server 'http://43.156.253.152' --token '<Worker Token>'
npm run mac:doctor
npm run mac:install
npm run mac:status
```

详见 [Mac Agent 文档](docs/mac-agent.md)。

## 腾讯云部署

已部署到腾讯云 Lighthouse：

- 外部地址：`http://43.156.253.152/`（nginx 80 按公网 IP 路由）
- 专用端口：`3410`（已配置，但 Lighthouse 防火墙尚未放行）
- API/Web 内部端口：`3411` / `3412`
- 详细记录：[腾讯云部署](docs/deploy-tencent.md)

## Mac 本地一体机评估

[Mac 本地一体机方案评估](docs/mac-local-server-assessment.md)：评估把平台、Web、Worker、本地 ASR 全部放在这台 Mac 上后台运行的可行性、睡眠/launchd/Tailscale/备份/转写性能等条件。

## 转写服务方案评估

[独立转写服务 + 远端平台方案评估](docs/remote-transcription-architecture.md)：推荐“远端平台常开 + Mac 本地转写 Worker + 产物回传远端”；如果远端只做 ASR，则中间层通常多余。

## 架构与流程图

- [架构与流程说明（Mermaid + 文字）](docs/architecture.md)
- [系统架构图](docs/diagrams/architecture.png)
- [任务执行流程图](docs/diagrams/task-flow.png)
- [调度触发流程图](docs/diagrams/schedule-flow.png)

重新生成 PNG：

```sh
python3 docs/render-diagrams.py   # 需要 Pillow
```

## 批量 Feed 任务

`scripts/seed-feeds.ts` 会为 9 个 Feed 各建一个 `show/sync` schedule（**默认全部停用**），并给知行小酒馆 run-now 一次：

```sh
node scripts/seed-feeds.ts
```

注意：脚本不创建 owner 用户；如果是全新数据目录，之后运行 `npm run bootstrap` 设置 Web 登录密码。

## 常用命令

```sh
npm run server            # 平台 API
npm run web               # Web 端
npm run worker:demo       # Demo Worker
npm run worker:podcast    # 播客 Worker
npm run worker:transcription  # 本地转写 Worker

npm run cli -- login
npm run cli -- apps list
npm run cli -- app register demo/manifest.json
npm run cli -- task history --limit 20
npm run cli -- task get <task_id>
npm run cli -- task logs <task_id> --after 0
npm run cli -- task close <task_id> --reason 'wrong input'
npm run cli -- task retry <task_id>
npm run cli -- schedule list

# 转写：提交给 transcription-tools Worker，等待并下载 Markdown
npm run cli -- transcribe 'https://example.com/audio.mp3' \
  --title '单集标题' --language zh --out ./transcript.md
# 只提交不等待
npm run cli -- transcribe 'https://example.com/audio.mp3' --no-wait
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TASKBASE_DATA_DIR` | `.data` | 数据目录（DB、产物） |
| `TASKBASE_HOST` / `TASKBASE_PORT` | `127.0.0.1` / `3333` | 平台 API 监听地址 |
| `TASKBASE_URL` | `http://127.0.0.1:3333` | CLI / Web Server 访问平台 API 的地址 |
| `TASKBASE_WEB_HOST` / `TASKBASE_WEB_PORT` | `127.0.0.1` / `3334` | Web 端监听地址 |
| `TASKBASE_WEB_SESSION_TTL_MS` | `43200000`（12 小时） | Web 会话有效期 |
| `TASKBASE_WEB_COOKIE_SECURE` | 无 | 设为 `1` 时 Cookie 加 `Secure`（HTTPS 部署） |
| `TASKBASE_LEASE_MS` | `60000` | 租约时长 |
| `TASKBASE_SWEEP_MS` | `5000` | 任务回收扫描间隔 |
| `TASKBASE_SCHEDULER_MS` | `5000` | 调度扫描间隔 |
| `TASKBASE_SCHEDULE_GRACE_MS` | `300000` | 漏跑判定窗口 |
| `TASKBASE_MAX_ARTIFACT_BYTES` | `5242880` | 单产物上限 |
| `TRANSCRIPTION_PROVIDER` | `whisper` | `whisper` / `funasr` / `elevenlabs` |
| `TRANSCRIPTION_MODEL` | Provider 默认 | FunASR/ElevenLabs 模型 |
| `FUNASR_BASE_URL` / `FUNASR_API_TOKEN` | 本机 8000 | 自托管 FunASR |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_BASE_URL` | — | ElevenLabs |
| `TRANSCRIPTION_ALLOW_INSECURE_HTTP` | 未设置 | 仅本地测试允许 HTTP/私网，生产不要开启 |
| `TRANSCRIPTION_WHISPER_BIN` | `whisper` | Whisper CLI 路径 |
| `TRANSCRIPTION_WHISPER_MODEL` | `small` | Whisper 模型（small/medium） |
| `TRANSCRIPTION_WHISPER_DEVICE` | `cpu` | `cpu` 或 `mps` |
| `TRANSCRIPTION_INITIAL_PROMPT` | 简体中文提示 | Whisper 初始提示 |
| `TASKBASE_CONFIG_DIR` | `~/.config/taskbase` | CLI 会话目录 |
| `TASKBASE_OWNER_USERNAME` | `owner` | 初始化用户名 |
| `TASKBASE_OWNER_PASSWORD` | 无 | bootstrap 密码 |
| `TASKBASE_PASSWORD` | 无 | CLI 非交互登录密码 |
| `TASKBASE_WORKER_TOKEN` | 无 | Worker 凭据（Demo / Podcast） |
| `TASKBASE_POLL_MS` / `TASKBASE_HEARTBEAT_MS` | `1000` / `15000` | Worker 轮询/心跳 |

## 播客规则

- 有 RSS 时按 RSS 全量列表入库；没有 RSS 时回退公开页，通常只有 15 集，标 `partial`。
- 只入库列表元数据（标题、发布时间、时长、音频地址等），**不下载音频**。
- `podcast_` 表与平台表在同一个 SQLite 文件；平台不读取播客表。
- 每节目一个 schedule：Web 节目库 → 定时，底层是平台 `show/sync` 调度。
- RSS 地址在 Web 添加节目时登记后，Worker 会优先使用 RSS；当前已实测《忽左忽右》入库 203 集。

## 代码结构

```text
src/
  main.ts          平台 API 入口
  bootstrap.ts     初始化所有者
  server.ts        HTTP 路由、认证、Worker 协议、产物传输、调度扫描
  store.ts         SQLite 持久化、队列、租约、回收、调度触发
  cron.ts          5 字段 cron 解析与下次触发
  schema.ts        JSON Schema 子集校验与 manifest 解析
  crypto.ts        Token、SHA-256、scrypt
  worker-sdk.ts    Worker HTTP 客户端
  worker-demo.ts   Demo Worker
  cli.ts           CLI
  podcast/
    manifest.ts    播客应用 manifest
    store.ts       podcast_ 表与采集记录
    parser.ts      小宇宙公开页解析
    rss.ts         RSS/Atom 解析
    worker.ts      Podcast Worker
  transcription/
    manifest.ts    转写应用 manifest
    store.ts       transcription_transcripts
    asr.ts         Whisper CLI Provider
    providers.ts   FunASR / ElevenLabs Provider
    safe-http.ts   HTTPS、DNS/IP、重定向和大小校验
    worker.ts      下载/转码/转写/产物上传
web/
  main.ts          Web 端入口
  server.ts        Session/CSRF、平台代理、播客 API、静态资源
  public/
    index.html     页面骨架
    app.js         原生前端逻辑
    styles.css     样式
demo/manifest.json Demo 应用声明
docs/
  architecture.md  架构与流程说明
  diagrams/        PNG 架构图/流程图
  screenshots/     本地 Web 截图（未纳入 Git）
test/
  base.test.ts     底座端到端测试
  podcast.test.ts  解析、播客表、Worker 测试
  web.test.ts      Web 会话/代理/播客 API 测试
scripts/
  seed-feeds.ts    9 个 Feed 的种子任务
```

## 测试

```sh
node --test test/*.test.ts
```

当前 **19 个测试全部通过**，覆盖任务闭环、恢复、超时、关闭/重试、cron/调度、播客/RSS 解析/入库/Worker、转写存储/Provider/安全下载、Web 登录/代理/播客 API。

真实进程验证过：

- platform + Web + Podcast Worker + 本地节目页 fixture：采集任务成功，Web 单集入库
- CLI + platform + Demo Worker：任务闭环与产物下载
- Playwright 登录 Web 并截图

## 数据与备份

- 默认数据在 `.data/`：`taskbase.sqlite`、`artifacts/`。
- 备份 = SQLite 数据库文件 + 产物目录；WAL 模式下建议停服务或使用 SQLite 在线备份。
- 平台表与 `podcast_` 表同库，备份一次即可。
- Web Session 只在内存，不写入数据库；重启 Web Server 后重新登录。

## 下一步

1. RSS 自动发现：页面 `<link rel=rss>` / Apple Podcasts / Podcast Index。
2. 在 RSS 入库后自动串联“单集 → 转写”任务。
3. FunASR/MLX 或云端 Provider 替换 Whisper CLI。
4. 平台 `app_state`、多产物/大二进制、多用户权限。
5. Web Session 持久化与部署层反向代理/TLS。
