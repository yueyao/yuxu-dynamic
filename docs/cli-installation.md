# CLI 安装与配置说明

本文面向 `yuxu-dynamic-cli` 的使用者，说明如何安装 `yuxu` 命令、连接玉虚平台并管理本机配置。CLI 只包含平台客户端，不会在本机安装平台 API 或 Worker；使用联网命令前，应先确保目标平台已经运行且可以访问。

## 1. 环境要求

- Node.js 24 或更新版本。
- npm 随 Node.js 一起安装。
- 本机平台可以使用 HTTP 回环地址；远端平台必须提供 HTTPS 根地址。

先检查环境：

```sh
node --version
npm --version
```

## 2. 安装

### 稳定版

稳定版发布后使用：

```sh
npm install --global yuxu-dynamic-cli
```

### 预发布版

需要试用 `next` 渠道时使用：

```sh
npm install --global yuxu-dynamic-cli@next
```

### 本地发布包

在项目仓库执行 `npm run pack:cli` 后，可以直接安装 `.release/` 中生成的 tarball：

```sh
npm install --global ./.release/yuxu-dynamic-cli-0.1.0-next.0.tgz
```

安装完成后验证命令入口：

```sh
yuxu --help
```

若终端找不到 `yuxu`，请重新打开终端，并确认 npm 的全局可执行文件目录已加入 `PATH`。

## 3. 配置平台地址

保存默认平台地址并查看生效配置：

```sh
yuxu config set-server https://platform.example.com
yuxu config show
```

本机开发平台默认地址为 `http://127.0.0.1:3333`。允许使用 HTTP 的地址仅限 `localhost`、`127.0.0.1` 和 `[::1]`；其他服务器必须使用 HTTPS。服务器地址只能是根地址，不能包含用户名、密码、子路径、查询参数或 fragment。

联网命令按以下优先级选择服务器：

1. 当前命令的 `--server <URL>`；
2. 环境变量 `PLATFORM_URL`；
3. `yuxu config set-server` 保存的地址；
4. 默认地址 `http://127.0.0.1:3333`。

可以临时访问另一个平台而不修改默认配置：

```sh
yuxu apps list --server https://another.example.com
```

## 4. 登录和退出

默认用户名为 `owner`。交互登录时，密码不会回显：

```sh
yuxu login
```

也可以指定用户名或临时服务器：

```sh
yuxu login --username owner --server https://platform.example.com
```

非交互环境可使用 `PLATFORM_PASSWORD` 提供登录密码。请只在受控环境中临时设置，不要把密码写入仓库、脚本或终端历史：

```sh
PLATFORM_PASSWORD='your-password' yuxu login
```

CLI 按服务器 origin 分别保存令牌，切换服务器不会把一个平台的令牌发送给另一个平台。删除指定平台的本机令牌：

```sh
yuxu logout --server https://platform.example.com
```

省略 `--server` 会删除本机保存的全部 CLI 令牌：

```sh
yuxu logout
```

当前 `logout` 只删除本机文件，服务端令牌撤销接口尚未实现。

## 5. 配置目录与环境变量

默认配置目录为 `$XDG_CONFIG_HOME/yuxu`；未设置 `XDG_CONFIG_HOME` 时使用 `~/.config/yuxu`。目录权限为 `0700`，配置与凭据文件权限为 `0600`。

| 变量 | 用途 |
| --- | --- |
| `YUXU_CLI_DIR` | 覆盖 CLI 配置目录，适合测试或隔离多套本机配置 |
| `PLATFORM_CLI_DIR` | 旧版配置目录覆盖变量，保留兼容 |
| `PLATFORM_URL` | 覆盖当前命令使用的平台地址 |
| `PLATFORM_TOKEN` | 临时覆盖本机保存的用户令牌 |
| `PLATFORM_ADMIN_USER` | 覆盖登录默认用户名 `owner` |
| `PLATFORM_PASSWORD` | 为非交互登录提供密码 |

CLI 会在首次读取时按需把旧的 `platform-cli` 配置迁移到 `yuxu` 目录。

## 6. 基本使用

登录后可发现应用和任务：

```sh
yuxu apps list
yuxu tasks list example-app
```

从文件提交任务并等待完成：

```sh
yuxu task run example-app/report/build --input report.json --wait
```

也可使用内联 JSON 或标准输入：

```sh
yuxu task run example-app/report/build --input-json '{"title":"日报"}'
echo '{"title":"日报"}' | yuxu task run example-app/report/build --input -
```

任务输入最多 60 KiB。`--wait --timeout <秒>` 只停止本地等待，不会取消仍在平台运行的任务。后续可继续查询：

```sh
yuxu task get TASK_ID
yuxu task result TASK_ID
yuxu task logs TASK_ID
yuxu task watch TASK_ID
```

下载产物时必须指定一个不存在的目标文件；CLI 不会静默覆盖已有文件：

```sh
yuxu artifact download ARTIFACT_ID --out report.txt
```

完整命令以 `yuxu --help` 为准。

## 7. 更新与卸载

更新稳定版或预发布版：

```sh
npm install --global yuxu-dynamic-cli@latest
npm install --global yuxu-dynamic-cli@next
```

卸载 CLI：

```sh
npm uninstall --global yuxu-dynamic-cli
```

卸载 npm 包不会自动删除 `~/.config/yuxu` 中的配置和令牌。如不再使用，应先运行 `yuxu logout`，再自行处理剩余的非凭据配置。

## 8. 常见问题

- `尚未登录`：先确认 `yuxu config show` 指向正确服务器，再对该服务器运行 `yuxu login`。
- 远端 HTTP 地址被拒绝：为远端平台配置 HTTPS；CLI 不提供跳过 TLS 校验的选项。
- `ECONNREFUSED` 或连接超时：确认平台 API 已启动、防火墙和反向代理允许访问，并检查地址与端口。
- 非交互登录报错：在受控的当前进程环境中设置 `PLATFORM_PASSWORD`。
- 下载提示文件已存在：换一个 `--out` 路径；当前版本没有强制覆盖选项。
- npm registry 找不到包：确认所选版本已经发布，并检查是否需要使用 `@next` 预发布渠道。

