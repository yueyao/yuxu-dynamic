# 腾讯云部署记录

部署时间：2026-11-06  
服务器：腾讯云 Lighthouse `lhins-iux3d3gt` / `43.156.253.152` / ap-singapore  
系统：OpenCloudOS 9.4，Node 24.22.2

## 访问地址

```text
http://43.156.253.152/
```

这是通过 nginx 的 **80 端口**、按公网 IP 的 `Host` 路由到 Taskbase。

专用端口：

| 端口 | 用途 | 外部访问 |
| --- | --- | --- |
| 80 | nginx：IP Host 路由到 Taskbase | 当前实际使用 |
| 3410 | nginx：Taskbase 专用入口 | 已配置，但 Lighthouse 防火墙未放行 |
| 3411 | Platform API，仅 127.0.0.1 | 否 |
| 3412 | Web Server，仅 127.0.0.1 | 否 |

如果要在腾讯云 Lighthouse 控制台放行 TCP 3410，之后可以直接使用：

```text
http://43.156.253.152:3410/
```

## 目录与数据

| 项 | 路径 |
| --- | --- |
| 代码 | `/opt/taskbase` |
| 数据 | `/var/lib/taskbase` |
| SQLite | `/var/lib/taskbase/taskbase.sqlite` |
| API env | `/etc/taskbase/api.env` |
| Web env | `/etc/taskbase/web.env` |
| Podcast Worker env | `/etc/taskbase/podcast-worker.env` |
| 转写 Worker Token | `/etc/taskbase/transcription-worker.token` |

## 已启动服务

```sh
systemctl status taskbase-api taskbase-web taskbase-podcast-worker
```

三个服务均已 `enabled`：

- `taskbase-api.service`
- `taskbase-web.service`
- `taskbase-podcast-worker.service`

nginx 仍是原服务，新增：

- `/etc/nginx/conf.d/taskbase.conf`（3410）
- `/etc/nginx/conf.d/taskbase-80.conf`（80，按 IP）
- 443 的 secondBrain 配置未改动

## 账号与凭据

- 用户名：`owner`
- 密码：`taskbase/.deploy/tencent-owner-password`（本机文件，600）
- 转写 Worker Token：`taskbase/.deploy/transcription-worker-token`（本机文件，600）

不要把 `.deploy/` 提交到 Git；`.gitignore` 已忽略。

## 已部署的数据

- 9 个播客节目
- 95 集《知行小酒馆》
- 9 个 schedule，全部未启用
- 1 个成功的 `show/sync` 任务

Podcast Worker 已在服务器运行；转写应用已注册，但**转写 Worker 不在 2C2G 服务器上运行**，因为本地 Whisper 需要更多 CPU/内存。

## 启动本机转写 Worker

在 Mac 上：

```sh
cd /Users/dynamic/Documents/GitHub/yuxu-dynamic/taskbase

YUXUN_URL='http://43.156.253.152' \
YUXUN_WORKER_TOKEN="$(cat .deploy/transcription-worker-token)" \
npm run worker:transcription
```

注意：

- 需要本机 `ffmpeg` 和 `whisper` CLI
- 默认 `whisper` `small` 模型
- Worker 会从远端领取任务、本机转写、把 Markdown 产物上传回远端
- 远端 Web 与 Worker 不同机时，Web 会从任务输出的 `text/segments/artifact_id` 恢复转写稿
- 本机 `.data` 的转写表只用于本机缓存，不是远端数据库

## 运维命令

```sh
# 查看服务
systemctl status taskbase-api taskbase-web taskbase-podcast-worker

# 查看日志
journalctl -u taskbase-api -f
journalctl -u taskbase-web -f
journalctl -u taskbase-podcast-worker -f

# 重启
systemctl restart taskbase-api taskbase-web taskbase-podcast-worker

# 更新代码后
cd /opt/taskbase
# 解压/替换代码
systemctl restart taskbase-api taskbase-web taskbase-podcast-worker

# 健康检查
curl http://127.0.0.1:3411/health
curl http://127.0.0.1:3412/api/health
curl -H 'Host: 43.156.253.152' http://127.0.0.1/api/health
```

## 安全说明

- 当前公网入口是 **HTTP**，没有 TLS；登录密码会以 HTTP 传输。
- 建议下一步：
  1. 用 Tailscale/SSH 隧道私有访问；
  2. 或给 3410/域名配 TLS 反向代理；
  3. 在 Lighthouse 控制台只放行必要端口；
  4. 定期备份 `/var/lib/taskbase`；
  5. 不要把 `.deploy/` 和 `/etc/taskbase/*.env` 提交到仓库。

## 本次验证

- 外部 `http://43.156.253.152/` 登录成功，总览加载 9 个节目、95 集
- `taskbase-podcast-worker` 领取真实 RSS 任务并成功
- `transcription-tools` 应用注册成功，Worker Token 已保存
- 服务内存约：
  - API 56 MB
  - Web 55 MB
  - Podcast Worker 84 MB
- 服务器剩余内存约 460 MB，另有 1.4 GB swap
