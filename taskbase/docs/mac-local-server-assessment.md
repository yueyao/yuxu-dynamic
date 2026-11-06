# Mac 本地一体机方案评估

评估时间：2026-11-06  
目标：把 Taskbase 平台、播客采集、音频转写都部署在一台 Mac 上，用户在后台启动整个服务。

## 1. 结论

**方案可行，适合“单用户、按需使用”的个人服务器；不建议把它当成 7×24 无人值守的公网服务器。**

推荐形态：

```text
Mac（M4 / 16GB / 10-core GPU）
  ├─ Taskbase Platform API   :3333
  ├─ Taskbase Web Server     :3334
  ├─ Podcast Worker           （Node）
  ├─ Transcription Worker     （Node）
  ├─ 本地 ASR 服务            :8000（Python / FunASR 或 MLX）
  └─ SQLite + artifacts + 临时音频
```

注意：这里的“一个 Server”应该是**一台机器上的多个进程**，不要把转写模型直接塞进 Node Web Server。Web 进程负责页面/API，ASR 进程负责 CPU/GPU 计算，二者隔离更稳。

## 2. 硬件与环境

当前本机：

| 项 | 配置 | 判断 |
| --- | --- | --- |
| 机器 | MacBook Air `Mac16,12` | 便携机，不是服务器机型 |
| 芯片 | Apple M4，10 核（4P+6E） | 单用户足够 |
| 内存 | 16 GB 统一内存 | 够 ASR 模型，但同时开大应用会吃紧 |
| GPU | 10 核 | 对 MLX Whisper 有帮助；FunASR 主要用 CPU |
| 磁盘 | 460 GB，当前约 129 GB 可用 | 音频/模型/产物空间足够，仍需清理策略 |
| 系统 | macOS 26.4.1 | 支持 `launchd`、`caffeinate` |
| 电源 | 当前 AC，系统睡眠设为 0（已禁止系统睡眠） | 适合短时服务；合盖/电池仍需注意 |
| 当前内存压力 | Swap 已用约 841 MB | 跑 ASR 前应关闭浏览器/DSH 等大程序 |

已有工具：Node 24、Python 3.13、`ffmpeg`、Homebrew、Docker、PyTorch 2.11。  
尚未安装：FunASR、MLX Whisper、Tailscale、Caddy。已安装并验证：OpenAI Whisper CLI（small/medium 模型缓存）。

## 3. 转写性能预估

以下是**量级估算**，不是本机实测：

| 方案 | 设备利用 | 1 小时音频 | 100 小时回填 |
| --- | --- | --- | --- |
| FunASR SenseVoiceSmall CPU | 4P+6E | 约 3–8 分钟 | 约 6–15 小时 |
| MLX Whisper large-v3-turbo | 10 核 GPU | 约 2–6 分钟 | 约 4–10 小时 |
| faster-whisper CPU | CPU | 约 12–30 分钟 | 不推荐 |
| 腾讯云 API | 不占本机 | 异步 | 100 小时约 80 元 |

MacBook Air 无风扇，连续跑 1–2 小时后可能降频；100 小时回填建议分批跑，保持电源接通，关闭大内存应用。10–30 分钟的日常单集任务没有问题。

## 4. 可行性判断

### 4.1 技术上可行

- Taskbase 已是 Node + SQLite + 本地文件，适合单机。
- Web/API/Worker 已经是独立进程。
- RSS 采集当前很轻；转写是主要 CPU/GPU 负载。
- Mac 的 10 核 CPU 和 10 核 GPU 足以支撑单用户顺序转写。
- 本地 ASR 可以完全离线，音频不出机器。

### 4.2 不适合的场景

- 需要 7×24 小时在线的远程服务。
- 多人使用或需要高可用。
- 大量并发转写。
- 需要公网直接暴露 Web/API。
- 对任务“到点必执行”有严格要求。

MacBook 会睡眠、重启、合盖、系统更新；这些都会让 Web 和调度暂停。

## 5. 必须补的运行能力

### 5.1 后台托管：用 launchd，不要只用 `nohup &`

建议为以下进程各建一个用户级 LaunchAgent：

- `com.taskbase.api`
- `com.taskbase.web`
- `com.taskbase.podcast-worker`
- `com.taskbase.transcription-worker`
- `com.taskbase.asr`（本地 Python ASR 服务）

关键设置：

- `RunAtLoad`：登录后自动启动
- `KeepAlive`：异常退出自动拉起
- `WorkingDirectory`：指向仓库
- `StandardOutPath` / `StandardErrorPath`：写日志
- `EnvironmentVariables`：`TASKBASE_*`、ASR 模型路径

一个统一脚本 `start-all / stop-all / status` 也可以，但 `launchd` 更可靠。

### 5.2 防止睡眠

当前 AC 电源下系统睡眠已是 `0`，但仍需注意：

- 接电源使用
- 保持开盖，或合盖时接外接显示器/电源
- 服务运行时用 `caffeinate -dimsu` 阻止空闲睡眠
- 不要依赖“合盖后继续跑”

如果 Mac 睡眠：

- API/Web 不可用
- 调度器停止，错过的触发不会补跑（这是当前设计）
- Worker 心跳中断，任务会进入恢复流程
- 长转写任务可能因租约/超时被关闭

因此转写任务的 `queue_timeout_ms` / `execution_timeout_ms` 应设为较长值（例如 2–6 小时），并依赖检查点恢复。

### 5.3 远程访问：优先 Tailscale / SSH 隧道

当前 Web 和 API 都绑定 `127.0.0.1`，这是安全的本地默认。

远程访问建议：

1. **Tailscale**（推荐）：Mac 和手机/笔记本加入同一个私有网络，访问 `http://mac-name:3334` 或 HTTPS。
2. **SSH 隧道**：`ssh -L 3334:127.0.0.1:3334 mac`。
3. 不建议直接在路由器上端口转发 3333/3334。
4. 如果确实要公网：必须加 TLS 反向代理、限流、安全 Cookie，并重新做威胁评估。

当前 Web Session 存在内存，重启即失效；这不是安全漏洞，但意味着服务重启后要重新登录。

### 5.4 转写服务要独立

建议：

```text
Node Transcription Worker
  → HTTP multipart → 127.0.0.1:8000/v1/audio/transcriptions
  → Python FunASR / MLX 服务
```

不要把 PyTorch/模型加载进 Web Server 进程。这样可以：

- 单独重启 ASR，不影响 Web
- 单独限制并发/内存
- 单独升级模型
- 避免 Node 事件循环被 CPU 计算拖死

### 5.5 音频与磁盘

- 音频下载到临时目录，转写后默认删除。
- 如保留音频，100 小时可能占几 GB；需要保留期限和清理任务。
- 转写文本放 SQLite/产物目录，体积很小。
- 模型缓存（FunASR/MLX）可能占几 GB，建议不纳入备份。

### 5.6 备份

至少包含：

- `taskbase.sqlite`
- `artifacts/`
- `podcast_transcripts`/产物文本
- 配置与 launchd plist

建议：

- Time Machine 定期备份
- 或用 `sqlite3 .backup` + 产物目录打包
- WAL 模式下不要在运行中直接复制单个 `.sqlite` 文件

## 6. 推荐验收标准

上线前按以下条件验收：

1. 断电重启后 `launchd` 能自动拉起 API/Web/Worker/ASR。
2. 手机通过 Tailscale 能访问 Web，公网端口不暴露。
3. Mac 睡眠/唤醒后任务能恢复，旧 Attempt 不覆盖结果。
4. 单集转写 1 小时音频成功，产物可下载，临时音频被清理。
5. 100 小时分批回填时内存不 OOM，温度/降频可接受。
6. SQLite + 产物备份可在另一目录恢复。
7. Web 会话重启后需要重新登录，这是预期行为。
8. 任务定义/Worker 的部署窗口避开转写高峰。

## 7. 成本

- 软件和模型：免费（FunASR/MLX）
- 本机边际成本：电费，通常几元级/100 小时
- 不需要云转写费用
- 代价：Mac 占用、发热、不能随时休眠、需要维护 Python/模型
- 对照：腾讯云 100 小时约 80 元，不占本机资源

## 8. 最终建议

**推荐把 Mac 作为“个人按需服务器”**：

- 平时开着 Web/API/Worker，按需转写
- 长回填分批跑
- 通过 Tailscale 私有访问
- 用 launchd 托管，用 caffeinate 防睡眠
- 转写独立进程，音频默认删除
- 接受“Mac 睡眠时服务不可用、调度不补跑”

如果要求 **7×24 在线、远程稳定、多人访问**，不要用 MacBook 当服务器；应把平台放在常开服务器，Mac 只做本地转写 Worker，或直接用云端 ASR。

当前新版本已有基础转写 Worker（Whisper CLI），但仍缺 `app_state`、launchd/Tailscale/备份脚本；采用本方案前建议先补运行托管与备份。旧仓库已归档在 `archive/pre-taskbase-20261106`，不会丢。
