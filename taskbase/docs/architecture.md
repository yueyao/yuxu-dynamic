# Taskbase 系统架构与流程

本文描述当前 `taskbase/` 独立工程的实现架构、Web 端、任务生命周期和调度流程。图分为可编辑的 Mermaid 源码和渲染后的 PNG（`docs/diagrams/`）。

> 说明：这里的“播客任务后台”是前文播客采集链路的 Web 端；不下载音频，只入库节目/单集列表元数据。

## 1. 系统边界

Taskbase 是一个**单用户、单服务器**的任务平台：

- 平台负责任务控制面：认证、应用/任务定义、队列、租约、事件/日志、产物元数据、cron 调度。
- 播客应用负责领域数据：`podcast_shows` / `podcast_episodes` / `podcast_ingest_runs`，由应用自己迁移；平台不读取这些表。
- Web 端包含**平台管理后台**和**播客任务后台**，浏览器只持有 Web 会话 Cookie，不接触平台 Owner Token 或 Worker Token。
- Podcast Worker 负责抓公开节目页并写入列表；当前不下载音频、不转录。
- 所有状态保存在同一个 SQLite 文件，产物保存在本地目录。

## 2. 架构图

![Taskbase 系统架构](diagrams/architecture.png)

- [系统架构 PNG](diagrams/architecture.png)
- [任务执行流程 PNG](diagrams/task-flow.png)
- [调度触发流程 PNG](diagrams/schedule-flow.png)
- [Web 总览](screenshots/overview.png)
- [播客节目库](screenshots/podcast-shows.png)
- [调度页](screenshots/schedules.png)

Mermaid 源码：

```mermaid
flowchart TB
    subgraph CLIENTS[客户端]
        CLI[CLI\n登录 / 提交 / 调度 / 产物]
        WEB[Web 端\n管理后台 + 播客任务后台]
    end

    subgraph SERVER[远程单服务器]
        WEBS[Web Server\nnode:http\n会话 Cookie / 平台代理 / 播客 API]
        API[Platform API\nnode:http]
        AUTH[认证与 Token]
        DEF[应用 / 任务定义]
        TASK[任务控制面\n队列 / 租约 / 尝试]
        SCH[调度器\n5 字段 cron]
        ART[产物服务]
        SDK[Worker SDK]
        W1[Demo Worker]
        W2[Podcast Worker]
        DB[(SQLite WAL\n平台表 + podcast_ 前缀表)]
        FILES[(本地产物目录)]
    end

    CLI -->|HTTPS/JSON| API
    WEB -->|HTTPS/JSON| WEBS
    WEBS -->|内部 HTTP| API
    WEBS -->|podcast_ 表| DB
    API --> AUTH
    API --> DEF
    API --> TASK
    API --> SCH
    API --> ART
    DEF --> DB
    TASK <--> DB
    SCH -->|到点创建任务| TASK
    SCH --> DB
    ART --> FILES
    W1 -->|lease/heartbeat/progress/complete| API
    W2 -->|lease/heartbeat/progress/complete| API
    W2 -->|podcast_ 表| DB
    W1 --> SDK
    W2 --> SDK
```

## 3. 组件职责

| 组件 | 当前实现 | 职责 |
| --- | --- | --- |
| CLI | `src/cli.ts` | 登录、应用注册、任务、调度、日志、产物下载 |
| Web UI | `web/public/` | 平台管理后台 + 播客任务后台；原生 HTML/CSS/JS |
| Web Server | `web/server.ts` | 登录会话、CSRF、平台 API 代理、播客领域 API、静态页面 |
| Platform API | `src/server.ts` | 认证、路由、Worker 协议、产物传输、调度扫描 |
| Store | `src/store.ts` | SQLite 持久化、幂等、队列、租约、尝试、回收、调度 |
| Cron | `src/cron.ts` | 5 字段 cron 解析、时区、下次触发计算 |
| Schema | `src/schema.ts` | 输入/输出 JSON Schema 子集与 manifest 校验 |
| Podcast Store | `src/podcast/store.ts` | `podcast_` 表、节目/单集 upsert、采集记录 |
| Podcast Parser | `src/podcast/parser.ts` | 小宇宙公开页 `__NEXT_DATA__` 解析 |
| RSS Parser | `src/podcast/rss.ts` | RSS 2.0 / Atom 解析、时间/时长/音频元数据 |
| Podcast Worker | `src/podcast/worker.ts` | RSS 优先、页面回退、日期过滤、partial 标记 |
| Transcription Store | `src/transcription/store.ts` | `transcription_transcripts` 文字稿表 |
| Whisper Provider | `src/transcription/asr.ts` | 本地 `whisper` CLI 转写、segments 解析 |
| Transcription Worker | `src/transcription/worker.ts` | 下载/ffmpeg/ASR/Markdown/产物上传 |
| Worker SDK | `src/worker-sdk.ts` | 领取、心跳、进度、日志、步骤、产物、完成/失败 |
| Demo Worker | `src/worker-demo.ts` | 验证端到端任务闭环 |
| SQLite | `.data/taskbase.sqlite` | 平台表 + 播客应用表 |
| 产物目录 | `.data/artifacts/` | 最终产物文件 |

## 4. 部署拓扑

当前为单机部署：

```text
浏览器 ──HTTP(S)──▶ Web Server ──HTTP──▶ Platform API
                         │                  │
                         └── SQLite ◀───────┘
                              ▲
                              │ lease / heartbeat
                    Podcast Worker / Demo Worker
```

- Platform API 默认 `127.0.0.1:3333`；Web 端默认 `127.0.0.1:3334`。
- Web 端与 Platform API 是**两个独立进程**；Web 端通过内部 HTTP 调平台，不直接写平台任务表。
- Web 端和 Worker 直接打开同一个 SQLite 文件访问 `podcast_` 表；WAL 允许并发读写。
- 反向代理/TLS 由部署层负责；当前 Web Cookie 默认不带 `Secure`，HTTPS 部署时设置 `TASKBASE_WEB_COOKIE_SECURE=1`。

## 5. Web 端

Web 端有两组导航：

- **平台管理**：总览、任务、应用、调度。
- **播客任务**：节目库、采集任务。

关键设计：

- 登录使用平台用户名/密码；Web Server 调平台登录接口，拿到 Owner Token 后只保存在服务端内存 Session。
- 浏览器只拿到 `tb_session` HttpOnly Cookie 和 CSRF Token；Owner Token / Worker Token 不进浏览器。
- Web Server 的 `/api/platform/*` 是**带会话鉴权的平台 API 代理**；非 GET 请求必须带 `X-CSRF-Token`。
- 播客领域 API 由 Web Server 直接读 `podcast_` 表；提交采集/同步任务时再调平台任务 API。
- Session 默认 12 小时，进程重启即失效，需要重新登录；这是单用户本地工具的简化选择。
- Web 端没有独立框架/构建步骤；静态资源由 `web/server.ts` 白名单提供，CSP 禁止内联脚本。

主要 Web API：

```text
POST /api/login
POST /api/logout
GET  /api/me
*    /api/platform/*          # 平台 API 代理
GET  /api/podcast/overview
GET  /api/podcast/shows
POST /api/podcast/shows
GET  /api/podcast/shows/:id/episodes
GET  /api/podcast/shows/:id/runs
GET  /api/podcast/runs
POST /api/podcast/collect
POST /api/podcast/shows/:id/sync
POST /api/podcast/shows/:id/schedule
GET  /api/podcast/schedules
POST /api/podcast/register
GET  /api/podcast/episodes/:id/transcript
POST /api/podcast/episodes/:id/transcribe
POST /api/transcription/register
```

## 6. 任务生命周期

![任务执行流程](diagrams/task-flow.png)

```mermaid
stateDiagram-v2
    [*] --> queued: 提交任务（幂等校验）
    queued --> running: Worker 领取（创建 Attempt + 租约）
    queued --> closed: 排队超时 / 人工关闭
    running --> succeeded: complete（输出 schema 校验）
    running --> failed: Worker 主动 fail
    running --> recovering: 租约过期且尝试未耗尽
    running --> closed: 执行超时 / 人工关闭
    recovering --> running: 新 Worker 领取
    recovering --> closed: 尝试耗尽 / 人工关闭
    succeeded --> [*]
    failed --> [*]: retry → 新任务
    closed --> [*]: retry → 新任务
```

关键语义：

- **至少一次执行**：恢复后允许重新执行；检查点（task_steps）保证复用已确认步骤。
- **尝试隔离**：只有当前 `attempt_id` 可以写入；旧 Attempt 返回 409 `STALE_ATTEMPT`。
- **幂等**：相同用户 + App + 任务 + 幂等键 + 输入返回原任务；输入不同返回 409。
- **超时**：排队超时 / 执行超时均进入 `closed`，原因 `QUEUE_TIMEOUT` / `TIMEOUT`。
- **关闭**：人工关闭立即置 `closed`，清租约并拒绝后续写入；不做 Worker 取消握手。
- **重试**：不修改原任务，创建新任务并记录 `retry_of_task_id`。

## 7. 任务执行时序

```mermaid
sequenceDiagram
    participant U as CLI / Web
    participant A as Platform API
    participant D as SQLite
    participant W as Worker

    U->>A: POST /v1/tasks {task, input}
    A->>D: 校验 schema / 幂等 / 插入 queued
    A-->>U: 202 {task_id}

    W->>A: POST /v1/worker/leases
    A->>D: 容量检查 + 创建 attempt + 租约
    A-->>W: 200 {task_id, attempt_id, input, steps, deadline}

    loop 执行期间
        W->>A: heartbeat / progress / logs / steps
        A->>D: 校验当前 attempt，写入事件
    end

    W->>A: PUT artifacts（可选）
    W->>A: POST complete {output}
    A->>D: 校验输出 schema / 产物归属，置 succeeded
    A-->>W: 200

    U->>A: GET /v1/tasks/:id/result
    A-->>U: succeeded + output + artifact_id
    U->>A: GET /v1/artifacts/:id/download
    A-->>U: 产物字节（校验大小/SHA-256）
```

## 8. RSS 采集流程

```text
Web 添加栏目（页面 URL + 可选 RSS URL）
  → Podcast Worker 领取 collect/sync 任务
  → 有 rss_url：fetchFeed → parseFeedXml → 两年过滤 → upsert source=rss（coverage=full）
  → 无 rss_url：抓公开页 → 解析 15 集 → upsert source=page（coverage=partial）
  → 写 podcast_ingest_runs
  → Web 展示已入库集数、RSS 总集数、覆盖状态
```

RSS 来源优先级：用户填写的 RSS → 页面 `<link rel="alternate" type="application/rss+xml">` → Apple Podcasts lookup → Podcast Index（可选）。当前已用 Apple Podcasts 搜索找到 9 个中文栏目 feed，并实测《忽左忽右》入库 203 集；详见 [RSS 来源与首批栏目](rss-sources.md)。

## 9. 转写流程

### 一次播客转写任务的完整流程

![一次播客转写任务完整流程](diagrams/transcription-flow.png)

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户 / Web UI
    participant W as Web Server
    participant P as Platform API
    participant Q as SQLite / Queue
    participant K as Mac Worker
    participant A as 音频源 / ASR

    U->>W: 点击单集「转写」
    W->>Q: 读取单集 audio_url / title / episode_id
    W->>P: POST /v1/tasks（transcription-tools/episode/transcribe）
    P->>Q: schema 校验 + 写 queued task + event
    P-->>W: 202 task
    W-->>U: 任务已排队

    K->>P: POST /v1/worker/leases
    P->>Q: lease + attempt
    P-->>K: 下发任务详情 input

    K->>A: 安全下载音频（HTTPS / DNS / 重定向 / 500MiB）
    K->>K: ffmpeg 16k 单声道 WAV
    K->>K: 按 TRANSCRIPTION_CHUNK_SECONDS 切片（默认 600s）

    loop 每个切片
        K->>A: ASR（Whisper / FunASR / ElevenLabs）
        A-->>K: text + segments
        K->>P: progress + saveStep asr-chunk-N
    end

    K->>K: 合并 text + segments（加 offset）
    K->>P: PUT transcript.md 产物
    P->>Q: 保存 artifact 元数据
    K->>P: complete(output)
    P->>Q: 校验 output schema，标记 succeeded + event

    U->>W: 打开 /#/transcript/:episode
    W->>Q: 服务端 transcription_transcripts 或 task output fallback
    Q-->>W: transcript
    W-->>U: transcript JSON
    U->>U: 渲染 Markdown 阅读页（不下载）
```

失败与恢复：

- Worker 主动失败 → `failed`
- 租约过期 → `recovering`
- 人工关闭/执行超时/排队超时/尝试耗尽 → `closed`
- 重试 → 新任务，记录 `retry_of_task_id`

```text
Web 转写队列 → “开始”
  → 服务端按顺序创建 transcription-tools/episode/transcribe
  → Transcription Worker 领取
  → 下载音频 → ffmpeg 16k mono → Whisper CLI → segments
  → 生成 transcript.md → 上传平台产物
  → complete
  → Web 写入服务端 transcription_transcripts
  → 转写稿查看/下载
```

- 默认 `whisper` CLI + `small` 模型；可用 `TRANSCRIPTION_WHISPER_MODEL` 改 `medium`。
- 产物是 Markdown；Worker 不写本地数据库，临时音频和中间文件用完即删。
- 服务端是唯一数据源：任务队列、转写稿、产物都以服务端为准。
- 远端 Web 与 Worker 不在同一台机器时，Web 从服务端任务输出恢复文字稿（包含 `text`/`segments`/`artifact_id`）。
- 临时音频默认删除；音频下载上限 500 MiB；执行超时 6 小时。

## 10. 调度流程

![调度触发流程](diagrams/schedule-flow.png)

```mermaid
sequenceDiagram
    participant S as 调度器
    participant D as SQLite
    participant W as Worker

    loop 每 5 秒（TASKBASE_SCHEDULER_MS）
        S->>D: 查询 enabled=1 AND next_fire_at <= now
        alt 同 schedule 有活动任务
            S->>D: 记录 skipped_overlap，推进 next_fire
        else 超过 grace 窗口
            S->>D: 记录 skipped_missed，推进 next_fire
        else 正常
            S->>D: 创建 source=schedule 任务（schedule_id + planned_fire_time）
            S->>D: 记录 created，推进 next_fire
        end
    end
    W->>D: 领取任务并执行
```

调度语义：

- 每个 schedule 独立：cron、时区、固定输入、启停、下次触发时间。
- 重叠：同 schedule 有未结束任务时跳过，不排队、不重复创建。
- 漏跑：超过 5 分钟 grace 窗口不补跑，记录 `skipped_missed`，推进到下一次未来触发。
- `run-now`：手动触发一次；若已有活动任务则返回 `skipped=overlap`。
- 调度任务与手动任务共用任务状态机、Worker 协议、事件、产物和恢复机制。

## 11. 失败、恢复、超时与重试

```text
Worker 崩溃 / 网络中断
  └─ 租约到期 ──▶ 尝试未耗尽 → recovering → 新 Attempt（读取已确认 steps）
                └ 尝试耗尽 → closed / ATTEMPTS_EXHAUSTED

执行超过 execution_timeout_ms
  └─ closed / TIMEOUT（迟到结果被拒绝）

排队超过 queue_timeout_ms
  └─ closed / QUEUE_TIMEOUT

worker 主动 fail
  └─ failed（平台不自动重试）

人工关闭
  └─ closed / 可填原因；迟到写入被拒绝

failed / closed
  └─ retry → 新任务（retry_of_task_id），原任务保留历史
```

## 12. 数据

平台表：

| 表 | 用途 |
| --- | --- |
| `users` / `api_tokens` / `worker_tokens` | 单用户认证、CLI Token、应用级 Worker 凭据 |
| `apps` / `task_definitions` | 应用与可覆盖更新的任务定义 |
| `tasks` | 任务实例、状态、输入/输出、关闭原因、调度来源 |
| `task_attempts` | 每次尝试与租约历史 |
| `task_steps` | 不可变检查点，恢复时复用 |
| `task_events` | 状态、进度、步骤、日志、产物事件 |
| `artifacts` | 产物元数据 |
| `schedules` / `schedule_runs` | cron 调度与触发历史 |

播客应用表（应用自迁移，平台不读）：

| 表 | 用途 |
| --- | --- |
| `podcast_shows` | 节目 URL、标题、RSS、覆盖状态、最近同步 |
| `podcast_episodes` | 单集列表元数据（标题、发布时间、时长、音频地址等，不下载音频） |
| `podcast_ingest_runs` | 每次采集的区间、状态、新增/更新数量、错误 |

## 13. API 能力

平台 API：

```text
POST /v1/auth/login
GET  /v1/apps
GET  /v1/apps/:app/tasks
POST /v1/apps
POST /v1/apps/:app/worker-token
POST /v1/tasks
GET  /v1/tasks
GET  /v1/tasks/:id
GET  /v1/tasks/:id/events
GET  /v1/tasks/:id/logs
GET  /v1/tasks/:id/result
POST /v1/tasks/:id/close
POST /v1/tasks/:id/retry
GET  /v1/artifacts/:id/download
POST /v1/schedules
GET  /v1/schedules
GET  /v1/schedules/:id
PATCH /v1/schedules/:id
DELETE /v1/schedules/:id
GET  /v1/schedules/:id/runs
POST /v1/schedules/:id/run-now
GET  /health
```

Worker API：

```text
POST /v1/worker/leases
POST /v1/worker/tasks/:id/heartbeat
POST /v1/worker/tasks/:id/progress
POST /v1/worker/tasks/:id/logs
POST /v1/worker/tasks/:id/steps
PUT  /v1/worker/tasks/:id/artifacts?name=...
POST /v1/worker/tasks/:id/complete
POST /v1/worker/tasks/:id/fail
```

## 14. 当前边界与下一步

已实现：

- 底座核心：任务闭环、恢复、超时、关闭/重试、产物、cron 调度。
- Web 管理后台：总览、任务、应用、调度。
- 播客任务后台：节目库、添加节目、两年范围采集、单节目同步、单集列表、采集记录、每节目 schedule。
- Podcast Worker：RSS 优先、小宇宙公开页回退、日期过滤、partial 标记、`podcast_` 表写入。
- 转写应用：本地 Whisper CLI、下载/转码/segments/Markdown 产物上传；Web 单集转写和转写稿查看。

未实现 / 下一步：

- RSS 自动发现 UI（当前已能手工填 RSS；Apple 搜索已用于离线调研）。
- 拉取入库后自动串联“单集 → 转写”；文章→Markdown。
- 平台 `app_state`、多产物/二进制大文件、多用户权限。
- Web Session 持久化与更细的权限（当前单用户，内存 Session）。
- 博客/文章发布（如果“博客”不是“播客”的笔误，需要另做领域层）。
