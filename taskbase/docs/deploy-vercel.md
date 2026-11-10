# Vercel 部署方案（不改源码）

> 结论先行：**在「不改动 `src/`、`web/` 任何代码」的前提下，这个项目不能整体跑在 Vercel 上。**
> 可行且推荐的是**混合部署**：Vercel 托管 Web 前端并反代 `/api/*`；平台 API、SQLite、Worker、调度器继续留在常开服务器。
> 对外效果：`https://taskbase.<域名>` 打开就是完整可用的后台；源码 0 改动，只多一份部署配置。

## 1. 这个项目的运行模型（代码事实）

| 事实 | 位置 |
| --- | --- |
| 平台 API 是常驻 HTTP 进程，监听 3333 | `src/main.ts:24`、`src/config.ts:20` |
| Web 是另一个常驻 HTTP 进程，监听 3334 | `web/main.ts:18` |
| 两个进程直接打开同一个 SQLite 文件（WAL） | `src/store.ts:72-76`、`web/server.ts:163-176` |
| 每 5 秒一次租约回收 + 调度扫描 | `src/config.ts:22-23` |
| Web 每 10 秒推进一次转写队列 | `web/server.ts:1092` |
| 数据与产物都在本地目录（单产物默认上限 5 MiB） | `src/config.ts:13`、`src/config.ts:25` |
| 转写 Worker 常驻轮询，且依赖本机 `ffmpeg` / `whisper` | `src/transcription/worker.ts:78` |
| 前端是纯静态文件（`web/public/`），hash 路由，同源请求 `/api/*` | `web/public/`、`web/public/app.js:331` |

一句话：它不是静态站，而是**有状态 + 常驻进程 + 本地磁盘**的服务端应用。

## 2. 为什么"纯 Vercel"不行

这不是配置问题，是平台模型不匹配：

1. **本地 SQLite 在 Vercel 无解。** Functions / Container 的文件系统只读，只有 `/tmp`（500 MB，随实例生死）；Daemons 明确不支持本地持久存储。Vercel 官方 KB 直接写 "SQLite … can't be used with Vercel"。
2. **没有常驻 HTTP 服务。** Container Runtime 可以跑自建 server，但空闲 5 分钟缩容、收到 SIGTERM 后 30 秒强杀；Daemons 能常驻，但明确**不接受任何入站 HTTP/TCP**。
3. **调度粒度不匹配。** 这里是 5 秒扫描；Vercel 旧版 Cron 在 Hobby 每天 1 次、Pro 每分钟 1 次，新版 Schedules 在 Hobby 最快 15 分钟、Pro 每分钟。
4. **Worker 本来就不该进来。** 播客 Worker 尚可放 Daemons，但转写 Worker 依赖本机 ffmpeg/whisper，天然属于 Mac/服务器。

→ 纯 Vercel = 换掉数据层、把两个 HTTP 进程改成函数、把调度和 Worker 改成 Queues/Daemons/Blob。**这是源码级重构**，不在"不改源码"的范围内（清单见 §8）。

## 3. 推荐架构

```text
浏览器 ──HTTPS──> Vercel（静态文件 + /api/* 反代）
                        │  HTTPS + 路径密钥
                        ▼
              origin.<域名> (nginx, TLS)
                        │
                        ▼ 127.0.0.1:3412
                 Web Server ──127.0.0.1:3411──> Platform API
                        │                              │
                        └────── 同一个 SQLite ─────────┘
                                              /var/lib/taskbase

CLI / Mac 转写 Worker ──直连──> api.<域名>:443（或现有 IP:80） /v1/*，不经 Vercel
```

设计要点：

- Vercel 只做两件事：**发静态文件** + **反代 `/api/*`**。这是 Fair Use 里的 "Hybrid apps / static sites"，合规。**不要**把全站反代——"Proxies and VPNs" 属于明确的 Never fair use。
- CLI 与 Worker **不走 Vercel**：代理超时上限 120 秒，而 Worker 是长轮询、CLI 默认要等 6 小时。它们继续直连 API 域名/IP。
- 数据、调度、租约全部仍在源站，Vercel 只是门面，挂掉也不影响 Worker。

## 4. 方案对比

| 方案 | 改源码 | 功能 | 说明 |
| --- | --- | --- | --- |
| **A 混合（推荐）** | 0 | 完整 | Vercel 前端 + `/api` 反代，后端留在常开机器 |
| B 纯 Vercel | 需要 | 完整（改造后） | Turso/Neon + Functions + Schedules + Daemons + Blob |
| C 只传静态 | 0 | 只能看登录页 | 适合 UI 预览，登录后无法使用 |
| D 全站反代 | 0 | 完整 | 技术可行，但违反 Vercel Fair Use，**不建议** |

## 5. 方案 A 实施步骤

### 5.1 前置条件

- Vercel 账号（Hobby 足够；个人非商业）。
- 一个域名；暂时没有可先用 `sslip.io`（例如 `43-156-253-152.sslip.io`，能签证书，不用买域名）。
- 源站 443 可达；若 443 被占用或防火墙未放行，用 Cloudflare Tunnel（出站连接，同样只需要一个域名）。

### 5.2 源站（腾讯云）准备

1. 给 `origin.<域名>` 签证书（certbot），nginx 新增 443 server block，**只放行带路径密钥的请求**：

```nginx
server {
    listen 443 ssl;
    server_name origin.example.com;

    ssl_certificate     /etc/letsencrypt/live/origin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/origin.example.com/privkey.pem;

    client_max_body_size 10m;

    # 路径密钥由 Vercel 的 rewrite 注入；其它来源一律 404
    location /__tb_7f3c9a1e/ {
        rewrite ^/__tb_7f3c9a1e/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:3412;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_x_real_ip;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }

    location / { return 404; }
}
```

   路径密钥换成自己的随机串（`openssl rand -hex 12`），与 §5.3 的 rewrite 保持一致。
   不想维护路径密钥的话，也可以直接 `location /api/ { proxy_pass http://127.0.0.1:3412; }`，安全性由登录 + 限流兜底。

2. Web 进程加一个环境变量（**不改代码**）：`TASKBASE_WEB_COOKIE_SECURE=1`。Vercel 侧是 HTTPS，Cookie 必须带 `Secure`。
3. 可选：把平台 API 的 `TASKBASE_MAX_ARTIFACT_BYTES` 调到 `4194304`（4 MiB），避开 Vercel 4.5 MB 的响应体限制。
4. 现有 80 端口继续给 CLI / Mac Worker 走 `/v1/*`（Token 鉴权），本次不动；建议后续收窄为只放 `/v1/`。

### 5.3 Vercel 项目

1. Import Git 仓库，**Root Directory 选 `taskbase`**。
2. Framework 选 **Other**；Build Command 留空；Output Directory 填 `web/public`（文件已在仓库里，无需构建）。
3. 在 `taskbase/vercel.json` 放下面内容（或按同样内容在 Dashboard 的 Routing/Headers 里配）：

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": null,
  "installCommand": "echo no-install-needed",
  "outputDirectory": "web/public",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://origin.example.com/__tb_7f3c9a1e/api/:path*"
    }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'"
        },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

   说明：
   - `rewrites` 只代理 `/api/*`，其余路径由 Vercel 静态托管；`headers` 把原 Web Server 的 CSP 原样补回来（见 `web/server.ts:531`）。
   - 想"零仓库改动"就在 Dashboard 配同样的 rewrite/headers；`vercel.json` 只是可复现版本。
   - 仓库若是公开的，路径密钥等于公开；这种情况建议仓库转私有，或接受"源站仍需登录 + 限流"（并不比现在公网 HTTP 更差）。

4. 绑定域名 `taskbase.<域名>`（CNAME 到 `cname.vercel-dns.com`），或先用 `*.vercel.app` 验证。
5. Deployment Protection 保持关闭（生产环境）。
6. 部署方式二选一：连 GitHub 后 push 自动部署；或在 `taskbase/` 下 `npx vercel --prod` 手动发布。

### 5.4 验收清单

- `https://taskbase.<域名>/` 打开登录页；Network 里 JS/CSS 来自 Vercel，`/api/*` 是反代结果。
- 登录成功；Cookie 为 `Secure; HttpOnly; SameSite=Lax`。
- 总览显示 9 个节目、95 集；节目库 / 单集库 / 采集任务 / 转写稿各页可打开。
- 触发一次同步（202）、单集"转写"入队、任务进度推进。
- 下载一个产物；再上传一个 >4.5 MB 的产物验证代理是否拦截（若失败就把上限压到 4 MiB）。
- `curl -i https://origin.<域名>/api/health` 应为 404（无路径密钥）；带密钥路径应为 200。
- Mac 上 `yuxun worker doctor`、`npm run worker:transcription` 仍连原地址正常工作。

### 5.5 回滚

- 删除 Vercel 的 rewrite（或下线项目）即可回到直连源站；源站不受影响。
- 备份策略不变：仍是 `/var/lib/taskbase`（SQLite + artifacts）。

## 6. 风险与规避

| 风险 | 说明 | 规避 |
| --- | --- | --- |
| 代理 120 秒超时 | 反代请求最长 120s | Web 接口都是毫秒级入队；CLI/Worker 不走 Vercel |
| 4.5 MB 响应体 | 明确限制针对 Functions；外部 rewrite 是否同样受限需实测 | 产物上限压到 4 MiB；转写稿远小于此 |
| Fair Use | 全站反代属于 "Proxies"，可能被限流/停用 | 只反代 `/api/*`，静态由 Vercel 托管 |
| Hobby 非商业 | Hobby 面向个人非商业项目 | 商用升级 Pro |
| 登录限流 | 限流按 socket IP 计数；反代后仍落在同一个 IP（当前 nginx 下本来如此） | 行为不变；需要时在 nginx 按真实 IP 限流 |
| 源站暴露 | `origin` 子域可直连 | 路径密钥 + 登录 + 限流；或 Cloudflare Tunnel + WAF |
| 单点 | 后端仍是单机 | 沿用现有备份；Vercel 不改变这一点 |
| Vercel 故障 | 页面打不开 | 源站仍在，CLI/Worker 不受影响；可临时改 DNS |

## 7. 待确认

1. 有没有域名？没有就先上 `sslip.io` 跑通。
2. 源站 443 是否可用？不可用就上 Cloudflare Tunnel。
3. 是否接受源站仍有 80/IP 直连入口（CLI 与 Worker 在用）？

## 8. 若要"纯 Vercel"（需改源码，本次不做）

| 改造点 | 工作量 |
| --- | --- |
| SQLite → Turso(libSQL) / Neon Postgres：`src/store.ts`、`web/server.ts`、podcast/transcription stores | 大 |
| 两个 HTTP 进程 → Vercel Functions（路由、会话、Cookie、CSRF 全要重做） | 中 |
| 5 秒租约/调度 → Schedules（Hobby 15 分钟 / Pro 1 分钟）+ 事件补偿 | 中 |
| Worker → Daemons（常驻但无入站）+ Queues | 中 |
| artifacts → Vercel Blob | 小 |
| Web Session → DB / 签名 Cookie | 小 |
| 本机 ffmpeg/whisper Worker 继续留在 Mac | 不变 |

## 9. 参考

- SQLite 与 Vercel：[vercel.com/kb/guide/is-sqlite-supported-in-vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)
- Functions 文件系统与 `/tmp`：[vercel.com/docs/functions/runtimes#file-system-support](https://vercel.com/docs/functions/runtimes#file-system-support)
- Container Runtime 缩容：[vercel.com/docs/functions/runtimes/container#scale-in-behavior](https://vercel.com/docs/functions/runtimes/container#scale-in-behavior)
- Daemons 限制（无入站 HTTP、无持久盘）：[vercel.com/docs/daemons/limits#unsupported-features](https://vercel.com/docs/daemons/limits#unsupported-features)
- 外部 rewrite / 反代：[vercel.com/docs/routing/rewrites#rewrites-to-external-origins](https://vercel.com/docs/routing/rewrites#rewrites-to-external-origins)
- 代理超时 120s：[vercel.com/docs/limits](https://vercel.com/docs/limits)
- 4.5 MB 请求/响应体：[vercel.com/docs/functions/limitations#request-body-size](https://vercel.com/docs/functions/limitations#request-body-size)
- Fair Use（Proxies 属 never fair use）：[vercel.com/docs/limits/fair-use-guidelines](https://vercel.com/docs/limits/fair-use-guidelines)
- Schedules 频率限制：[vercel.com/docs/schedules/limits](https://vercel.com/docs/schedules/limits)
