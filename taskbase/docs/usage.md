# Taskbase 文档导航

更新：2026-11-06

Taskbase 的 Web 服务和 CLI 是两套独立客户端，文档分开维护。

## 使用文档

| 文档 | 内容 |
| --- | --- |
| [Yuxun Web 使用文档](web.md) | 登录、节目库、采集、任务、调度、转写稿阅读 |
| [Yuxun CLI 使用文档](cli.md) | 安装、登录、任务、调度、产物、Worker |

## 设计与运维

| 文档 | 内容 |
| --- | --- |
| [CLI 架构审计](cli-architecture.md) | 当前安装形态、CLI/Worker 边界、重构计划 |
| [腾讯云部署](deploy-tencent.md) | 远端服务、端口、systemd、nginx、数据目录 |
| [架构](architecture.md) | 平台、任务、播客、转写流程 |
| [RSS 来源](rss-sources.md) | 已验证的播客源 |
| [旧逻辑迁移审计](legacy-migration-audit.md) | 旧仓库能力覆盖情况 |

## 当前入口

```text
Web:  http://43.156.253.152/
CLI:  yuxun
```

Web 负责创建任务和阅读转写稿；CLI 负责管理任务、调度和 Mac Worker。
