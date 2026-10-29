# CLI 发布说明：0.1.0-next.0

发布日期：待定  
发布渠道：`next` 预发布  
npm 包：`yuxu-dynamic-cli`  
终端命令：`yuxu`  
Git tag：`yuxu-cli-v0.1.0-next.0`

`0.1.0-next.0` 是玉虚个人 CLI 的首个候选预发布版本。它面向熟悉命令行的个人开发者，通过平台 HTTP API 完成登录、任务发现、任务提交、状态跟踪、日志读取、结果查询和产物下载。任务代码仍在平台侧 Worker 中执行，CLI 不直接访问数据库，也不包含 Worker 凭据。

## 本版亮点

- 独立 npm 包发布，安装后提供 `yuxu` 命令，不依赖仓库中的 TypeScript 源码或服务端模块。
- 支持保存默认服务器，并通过 `--server` 或 `PLATFORM_URL` 临时切换。
- 用户令牌按服务器 origin 隔离保存，避免切换平台时误用凭据。
- 支持文件、内联 JSON 和标准输入三种任务输入方式。
- 支持立即任务和带 `--run-at` 的单次计划任务。
- 支持幂等键、提交后等待、事件跟踪、历史分页、结果与 Worker 日志查询。
- 支持下载任务产物，并默认拒绝覆盖已有文件。
- 远端平台强制 HTTPS；本机回环地址可使用 HTTP。

## 已包含命令

```text
yuxu config set-server <URL>
yuxu config show
yuxu login [--username <name>]
yuxu logout [--server <URL>]
yuxu apps list
yuxu tasks list <app-id>
yuxu tasks history [filters]
yuxu task run <app-id/task-key> [options]
yuxu task get <task-id>
yuxu task result <task-id>
yuxu task logs <task-id> [--after <event-id>]
yuxu task watch <task-id> [--timeout <秒>]
yuxu artifact download <artifact-id> --out <path>
```

所有联网命令均可使用 `--server <URL>` 临时选择平台。完整参数以 `yuxu --help` 为准。

## 安装

本版发布到 npm 后，通过 `next` 渠道安装：

```sh
npm install --global yuxu-dynamic-cli@next
yuxu --help
```

Node.js 最低版本为 24。详细的服务器配置、凭据目录和使用示例见 [CLI 安装与配置说明](./cli-installation.md)。

## 包名调整

候选发布包在首次公开发布前由 `yuxu-platform-cli` 更名为 `yuxu-dynamic-cli`。终端命令仍为 `yuxu`，本机配置目录仍为 `~/.config/yuxu`，因此此次包名调整不会改变命令或配置格式。

## 安全与配置行为

- 交互登录不回显密码；自动化场景可临时使用 `PLATFORM_PASSWORD`。
- 配置目录默认权限为 `0700`，配置与令牌文件权限为 `0600`。
- 每个服务器使用独立凭据文件；令牌文件内容会再次校验服务器 origin。
- `PLATFORM_TOKEN` 可临时覆盖本机令牌，但调用方需确保它属于当前服务器。
- 服务器地址不允许包含凭据、子路径、查询参数或 fragment。
- CLI 不支持关闭 TLS 校验。

## 已知限制

- 当前没有 `yuxu version`、shell completion、命名 profile 或系统凭据库集成。
- `task watch` 使用事件游标轮询，尚未使用 SSE。
- 平台尚未提供取消和手动重试 API，因此 CLI 没有对应命令。
- `logout` 只删除本机令牌，不能撤销服务端已签发令牌。
- 任务 JSON 输入上限为 60 KiB；输入附件尚未实现。
- `--wait` 超时只停止客户端等待，远端任务仍会继续运行。
- 产物下载不支持覆盖已有文件。

## 发布前验证

2026-10-29 已完成以下本地验证：

- `npm run pack:cli` 成功生成 `yuxu-dynamic-cli-0.1.0-next.0.tgz`。
- `npm run smoke:cli-package` 完成隔离全局安装，并验证 `yuxu --help` 与服务器配置命令。
- `npm test` 共 18 项测试通过。
- `npm run typecheck` 通过。

本文记录的是候选发布内容，不表示 npm registry 已经完成发布。维护者的 tag、OIDC 和 Trusted Publisher 操作见 [CLI npm 发布流程](./cli-release.md)。

