# yuxu-platform-cli

玉虚（Yuxu）共享应用平台的命令行客户端。CLI 通过平台 HTTP API 提交和查询任务；任务由平台侧 Worker 执行。

需要 Node.js 24 或更新版本。安装稳定版：

```sh
npm install --global yuxu-platform-cli
yuxu --help
```

预发布版本使用 `next` 标签安装：

```sh
npm install --global yuxu-platform-cli@next
```

配置平台并登录：

```sh
yuxu config set-server https://platform.example.com
yuxu login
yuxu apps list
```

本机开发地址可使用 HTTP；远端平台必须使用 HTTPS。CLI 配置默认保存在 `~/.config/yuxu`（遵循 `XDG_CONFIG_HOME`），可使用 `YUXU_CLI_DIR` 覆盖；登录令牌按服务器地址隔离并以仅当前用户可读的文件保存。

提交并等待任务：

```sh
yuxu task run example-app/report/build --input report.json --wait
yuxu task result TASK_ID
yuxu artifact download ARTIFACT_ID --out report.txt
```

完整命令和平台本地部署说明见[项目仓库](https://github.com/yueyao/yuxu-dynamic)。
