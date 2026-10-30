# 玉虚（Yuxu）：共享应用平台

当前版本实现了一个可运行的任务底座：CLI 或应用后端提交立即/单次计划任务，独立 Worker 领取任务、记录步骤、进度和日志，返回结构化结果或文件产物；平台持久化历史与状态，在 Worker 中断后回收租约并继续执行。目标架构见 [总体方案](./docs/index.md)，客户端、平台和服务端 Worker 的职责边界见 [服务端任务设计](./docs/server-task-design.md)，接口契约见 [任务底座调用与状态契约](./docs/task-platform-flow.md)，现有代码的逐模块说明见 [模块说明](./docs/modules.md)。

个人 CLI 的命令、配置安全、输出行为和后续开发路线见 [个人 CLI 设计](./docs/personal-cli-design.md)。

## 时间查询验证任务

现有任务平台增加了独立的 `time-cli` 和 `time-worker`。CLI 可配置服务器地址，提交 `time-service/time/now` 任务，等待服务器侧 Worker 执行，并直接显示返回的 UTC 时间。完整启动命令、数据流和配置见 [时间查询闭环](./docs/time-query-flow.md)。在允许监听本机端口的环境，可运行 `npm run smoke:time` 验证三个独立进程。

`npm test` 还会让 CLI、API 和 Worker 分别以子进程运行，经进程间通道调用生产 HTTP 路由。此测试验证了进程边界与数据库交互；真实 TCP 端口仍由 `npm run smoke:time` 验证。

## 环境要求

- Node.js 24 或更新版本。运行时只使用 Node.js 内置模块；`npm ci` 仅用于安装 TypeScript 类型检查依赖。
- 当前 MVP 在本机使用 SQLite 和 `.local/artifacts/`，无需 PostgreSQL、Docker 或对象存储。

## 启动

在项目根目录执行一次初始化。设置一个至少 12 个字符的密码，不要把密码写入仓库：

```sh
export PLATFORM_ADMIN_PASSWORD='自行设置的长密码'
npm run bootstrap
unset PLATFORM_ADMIN_PASSWORD
```

初始化会创建 `.local/platform.sqlite` 与仅当前用户可读的 `.local/worker-token`。随后分别在两个终端启动 API 和 Worker：

```sh
npm run server
```

```sh
npm run worker
```

第三个终端登录并提交示例任务：

```sh
npm run yuxu -- login
printf '%s\n' '{"title":"我的首份报告"}' > .local/input.json
npm run yuxu -- apps list
npm run yuxu -- tasks list example-app
npm run yuxu -- task run example-app/report/build --input .local/input.json
npm run yuxu -- task watch TASK_ID
npm run yuxu -- task result TASK_ID
npm run yuxu -- task logs TASK_ID
npm run yuxu -- tasks history --app example-app --limit 20
npm run yuxu -- artifact download ARTIFACT_ID --out .local/report.txt
```

日常开发可在仓库根目录依次执行 `npm run build:cli` 和 `npm link`，之后直接运行 `yuxu --help`。根目录是私有开发包；独立 CLI 包位于 `apps/cli`，发布说明见 [CLI npm 发布流程](./docs/cli-release.md)。个人 CLI 配置默认保存在 `~/.config/yuxu`（遵循 `XDG_CONFIG_HOME`）；令牌按服务器地址分别保存。可用 `YUXU_CLI_DIR` 指定本机配置目录，旧变量 `PLATFORM_CLI_DIR` 仍可使用。

### 安装 CLI

项目根目录执行 `npm run pack:cli` 会在 `.release/` 生成独立 CLI npm 包；`npm run smoke:cli-package` 会在临时目录安装并验证该包。Node.js 24 或更新版本上可直接安装本地产物：

```sh
npm install --global ./.release/yuxu-dynamic-cli-0.1.0-next.0.tgz
yuxu --help
```

首次 npm 预发布后可安装 `yuxu-dynamic-cli@next`；稳定版发布后使用：

```sh
npm install --global yuxu-dynamic-cli
```

源码开发仍可使用 `npm run yuxu -- ...`；修改 CLI 后重新执行 `npm run pack:cli` 生成安装包。使用者可参阅 [CLI 安装与配置说明](./docs/cli-installation.md) 和 [0.1.0-next.0 发布说明](./docs/cli-release-notes.md)；维护者的发布流程和 npm Trusted Publisher 配置见 [CLI npm 发布流程](./docs/cli-release.md)。

配置并登录平台：

```sh
yuxu config set-server http://127.0.0.1:3333
yuxu login
yuxu config show
```

远端平台地址必须使用 HTTPS。临时连接其他服务器可给联网命令添加 `--server <URL>`；不同服务器的登录令牌彼此独立。

把 `TASK_ID` 和 `ARTIFACT_ID` 分别替换成命令返回的 ID。`yuxu login` 默认使用用户名 `owner`，交互式输入密码；也可设置 `PLATFORM_ADMIN_USER`。服务地址默认 `http://127.0.0.1:3333`，可用 `PLATFORM_URL` 覆盖。`.local/` 已被 Git 忽略。

需要指定一次性执行时间时，提交命令追加 `--run-at 2026-10-26T08:00:00+08:00`；需要安全重试提交时追加 `--idempotency-key <key>`。`tasks list <app-id>` 查看任务定义，`tasks history` 查看已提交的任务实例；历史响应中的 `next_cursor` 可通过 `--cursor` 读取下一页。应用后端可导入 [`PlatformClient`](./packages/client-sdk/src/index.ts) 调用同一套用户 API。当前没有 Web 会话，浏览器页面应经应用后端调用平台。

## 验证与配置

```sh
npm test
npm ci
npm run typecheck
```

测试使用进程内 HTTP 请求，不需要开放本机端口。API 只绑定本机回环地址。可配置 `PLATFORM_DATA_DIR`、`YUXU_CLI_DIR`（旧名 `PLATFORM_CLI_DIR`）、`PORT`、`PLATFORM_LEASE_MS`、`PLATFORM_SWEEP_MS`、`WORKER_HEARTBEAT_MS`、`WORKER_POLL_MS` 和 `EXAMPLE_TASK_DELAY_MS`。缩短租约做恢复演示时，心跳间隔应明显短于租约。

本地 MVP 自带 `example-app/report/build` 文本任务，也可注册其他应用的任务声明。任务输入和输出使用受控 JSON Schema 子集校验，Worker 通信与检查点已抽成通用 SDK。SQLite、本地文件和 `scrypt` 仍分别需要迁移到 PostgreSQL、对象存储和成熟认证库；详见 [实现路径](./docs/implementation-plan.md)。

### 注册其他本地应用

平台现可通过 `npm run register-app -- manifest.json` 注册新的应用和任务声明。声明包含 `app_id`、`release_digest`、`max_concurrency`，以及任务列表中的 `task_key`、`input_schema`、`output_schema`、`timeout_ms` 和 `max_attempts`。注册命令会在 `.local/worker-token-<app_id>` 创建该应用的 Worker 凭据；应用 Worker 可复用 [Worker SDK](./packages/worker-sdk/src/index.ts)。同一应用的版本更新与回滚仍需后续发布阶段实现。

```json
{
  "app_id": "notes-app",
  "release_digest": "release-1",
  "max_concurrency": 2,
  "tasks": [{
    "task_key": "note/export",
    "timeout_ms": 60000,
    "max_attempts": 2,
    "input_schema": {
      "type": "object",
      "required": ["note_id"],
      "properties": { "note_id": { "type": "string", "minLength": 1 } },
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "required": ["artifact_id"],
      "properties": { "artifact_id": { "type": "string" } }
    }
  }]
}
```

注册仅让平台识别任务；还需启动匹配 `app_id` 与 `release_digest` 的应用 Worker，任务才会执行。当前版本不支持覆盖已注册的应用。
