# Taskbase 文档导航

更新：2026-11-09

Taskbase 的 Web 服务和 CLI 是两套独立客户端，文档分开维护。

## 规范与验收

| 文档 | 内容 |
| --- | --- |
| [当前项目规范与验收审查](../../spec/taskbase-current-spec.md) | 当前行为、运行命令、测试基线、原始 AC 对照与范围决定；2026-11-10 确认按现有功能交付，生产运维验收暂缓 |
| [原始独立需求](../../spec/personal-task-platform-requirements.md) | 原始 FR/NFR/AC；包含尚未实现的要求，不能当作已实现清单 |

当前工作区在 Node 24.19.0 下完整测试 49/49 通过，原始 MVP 尚未全验收。线上状态、真实 ASR 和生产恢复不由该测试结果证明。带日期的审阅报告按各自日期解读。

## 使用文档

| 文档 | 内容 |
| --- | --- |
| [Yuxun Web 使用文档](web.md) | 登录、节目库、采集、任务、调度、转写稿阅读 |
| [Yuxun CLI 使用文档](cli.md) | 安装、登录、任务、调度、产物、Worker |
| [转写稿对外 API](api.md) | Bearer Token、列表、详情、Markdown 下载 |

## 设计与运维

| 文档 | 内容 |
| --- | --- |
| [CLI 架构审计](cli-architecture.md) | 当前安装形态、CLI/Worker 边界、重构计划 |
| [腾讯云部署](deploy-tencent.md) | 远端服务、端口、systemd、nginx、数据目录 |
| [HTTPS 切换](https.md) | 域名、证书、nginx、客户端迁移 |
| [数据保护与保留策略](operations.md) | 在线备份、完整性校验、恢复演练、日志与产物清理 |
| [架构](architecture.md) | 平台、任务、播客、转写流程 |
| [播客应用产品审阅](product-review-2026-11-07.md) | 页面走查、管理需求差距与优化路线 |
| [Web 功能完整性复核](web-completeness-review-2026-11-08.md) | 2026-11-08 历史快照；部分分页与 Worker 状态缺口已被后续实现覆盖 |
| [早期验收审计](acceptance-audit.md) | 2026-11-06 历史记录；当前验收结论见项目规范 |
| [采集结果展示需求](requirements-episode-library.md) | 单集库的页面、接口与分期方案 |
| [RSS 来源](rss-sources.md) | 已验证的播客源 |
| [旧逻辑迁移审计](legacy-migration-audit.md) | 旧仓库能力覆盖情况 |

## 入口记录

```text
Web:  http://43.156.253.152/
CLI:  yuxun
```

Web 负责创建任务和阅读转写稿；CLI 负责管理任务、调度和 Mac Worker。

上述 HTTP 地址是历史部署入口，本轮未核验线上可用性与 HTTPS 切换状态；安全公网入口应按 HTTPS 部署文档配置。
