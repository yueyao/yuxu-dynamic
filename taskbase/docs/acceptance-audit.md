# 项目验收审计（2026-11-06）

> 历史快照：以下结论仅适用于 2026-11-06 当时的代码与工作树，不用于判断当前完成度。会话持久化、Provider、分页、备份工具及归档状态已有后续变化；当前事实和原始 AC 对照见[2026-11-09 项目规范与验收审查](../../spec/taskbase-current-spec.md)。旧测试数与部署记录保留供追溯。

对照 `spec/personal-task-platform-requirements.md` 与当前 `taskbase/` 实现，结论：

- **按“底座 + 播客列表采集应用”当前范围**：基本完成。
- **按需求文档的完整 MVP 验收（AC-01～AC-17）**：**未完成**，缺 `app_state` 与“拉取 → 转写”链路，远程 HTTPS/备份恢复也未验收。
- 因此**暂不建议直接把整个仓库替换成当前版本**；先确认是否接受这些缺口，或先补齐再替换。

## 1. 底座能力

| 需求 | 状态 | 证据/说明 |
| --- | --- | --- |
| 单所有者、密码登录、CLI Token | 完成 | `bootstrap`、`/v1/auth/login`、90 天 Token |
| App/任务定义注册、覆盖更新、无版本 | 完成 | `POST /v1/apps`，测试覆盖更新 |
| 一个 App 多任务、Worker 凭据隔离 | 完成 | `podcast-tools` 两个任务；用户/Worker Token 互斥 |
| 任务提交、schema 校验、幂等 | 完成 | 测试 + 真实任务 |
| 队列、租约、心跳、进度、日志、检查点 | 完成 | 测试 + Worker SDK |
| 中断恢复、旧 Attempt 隔离 | 完成 | `recovering`、`STALE_ATTEMPT` 测试 |
| 排队/执行超时、关闭/重试 | 完成 | 默认 1h、最大 6h；测试覆盖 |
| 单产物上传/下载/SHA-256 | 完成 | 测试覆盖 |
| cron 调度、重叠跳过、漏跑不补、run-now、调度上下文 | 完成 | 测试覆盖 |
| CLI 全流程 | 完成 | 登录、任务、调度、产物 |
| Web 管理后台 + 业务任务后台 | 完成（超出 MVP） | 会话 Cookie、CSRF、平台代理、播客任务 |
| **`app_state` 跨次 KV + 版本/CAS** | **未完成** | 无表、无 API、无 Worker 权限；AC-13 不满足 |
| 拉取 → 转写链路 | **部分完成** | 转写任务已实现（Whisper CLI，本地）；尚未在 RSS 入库后自动串联提交转写；AC-12 的“同一任务内串行”未完成 |
| 远程 HTTPS + Token 验收（AC-01） | 未验收 | 本地/演示运行过；未部署公网入口 |
| 数据库+产物备份恢复（AC-16） | 未验收 | 没有恢复演练测试 |
| Web 会话持久化 | 未实现 | 内存 Session，重启需重新登录（非 MVP 项） |

## 2. 第一个应用（播客列表采集）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 节目/单集表（`podcast_` 前缀） | 完成 | `podcast_shows`、`podcast_episodes`、`podcast_ingest_runs` |
| RSS 2.0 / Atom 解析 | 完成 | `src/podcast/rss.ts`，14 个测试 |
| 小宇宙公开页 fallback | 完成 | `src/podcast/parser.ts` |
| 两年范围过滤 | 完成 | 2024-11-06 → 2026-11-06 |
| 不下载音频 | 完成 | 只存列表元数据 |
| Web 添加/搜索/展示/采集 | 完成 | 节目库、采集任务、最近采集 |
| 每节目一个 schedule | 完成 | 9 个 schedule，默认停用 |
| 真实数据验证 | 完成 | 忽左忽右 203 集；知行小酒馆 95 集 |
| 音频转写 | 已实现基础版（Whisper CLI） | 新 app `transcription-tools`；本地 WAV 端到端通过；尚未接 FunASR/MLX/云端 |

## 3. 仓库替换的影响

当前旧仓库 `yuxu-dynamic` 还包含：

- 播客音频转写 Worker（`apps/podcast-tools`）
- 自托管 FunASR Provider、转写研究文档
- 旧平台 API/CLI/Worker 与测试
- 现有文档、发布脚本、Git 历史

如果直接用 `taskbase/` 替换根目录：

- 会删除旧转写实现（除非先归档/迁移）。
- 新版本有 RSS/列表/Web，但没有转写和 `app_state`。
- 旧需求文档的完整 MVP 不会因此满足，只是换了实现基座。

## 4. 建议

**建议先做安全归档，再决定替换范围：**

1. 为旧仓库创建归档分支/标签（保留全部 Git 历史）。
2. 二选一：
   - **A. 接受当前范围**：以 `taskbase/` 为新的仓库根，旧转写归档；明确 `app_state`/转写后续再做。
   - **B. 补齐后再替换**：先实现 `app_state`，并把旧仓库的转写 Worker 迁移/合并到新底座，再替换。
3. 替换前运行：14 个测试 + 类型检查 + 真实 RSS 任务；替换后根目录再跑一次，避免路径变化。

## 5. 当前验证

- `node --test test/*.test.ts`：16/16 通过
- TypeScript 类型检查：通过
- 真实 RSS：《忽左忽右》654 条 feed，两年 203 集入库；《知行小酒馆》270 条 feed，两年 95 集入库
- 真实转写：本地 WAV → Whisper small → Markdown 产物上传/下载通过
- 本地 `.data` 已建 9 个节目、9 个停用 schedule、1 个成功任务、95 集单集；**尚无 owner 用户**，需 bootstrap 后登录 Web

## 6. 归档决策

2026-11-06：用户选择**先归档，暂不替换**。

- 归档分支：`archive/pre-taskbase-20261106`
- 归档标签：`archive/pre-taskbase-20261106`
- 归档提交：`d7786af`
- 当前旧仓库工作树保持不动；新版本仍位于 `taskbase/`。
