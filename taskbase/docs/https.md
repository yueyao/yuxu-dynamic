# HTTPS 切换

仓库提供 `deploy/tencent/nginx-https.conf` 模板。域名必须解析到源站，证书需覆盖该域名；API/Web 的内部 HTTP 端口继续只监听 loopback。

1. 在现有 80 配置中增加 `/.well-known/acme-challenge/` 静态目录 `/var/www/letsencrypt`，执行 `nginx -t` 后 reload。
2. 使用 certbot webroot 为域名签发证书。签发完成后渲染模板：

```sh
export TASKBASE_DOMAIN='taskbase.example.com' # 替换为实际域名
envsubst '${TASKBASE_DOMAIN}' < deploy/tencent/nginx-https.conf > /tmp/taskbase-https.conf
sudo install -m 644 /tmp/taskbase-https.conf /etc/nginx/conf.d/taskbase-https.conf
```

3. 备份并移出旧的 Taskbase 80/3410 配置（其它站点保持原样），执行 `sudo nginx -t` 后 `sudo systemctl reload nginx`。防火墙开放 443，关闭公网 3410/3411/3412。
4. `/etc/taskbase/web.env` 增加 `YUXUN_PUBLIC_URL=https://实际域名`。Web 会自动使用 Secure Cookie；重启 Web 后确认 `Set-Cookie` 包含 `Secure; HttpOnly; SameSite=Lax`。
5. CLI 重新以 `yuxun login --server https://实际域名` 登录，Mac 执行 `yuxun worker pair --server https://实际域名 --token '<Token>'`，再 `yuxun worker install`。不要依靠 HTTP 重定向传输凭据，客户端必须直接使用 HTTPS。
6. 验证 HTTPS 登录、转写提交、Worker 心跳、Markdown 下载；确认 HTTP 只返回 308。配置证书自动续期及续期后的 nginx reload。
7. 确认客户端迁移后，轮换曾在 HTTP 上传输过的 Worker/API 凭据，并撤销旧登录会话。

本模板需要实际域名和证书后才能启用。直接使用 IP 的旧部署仍以 `docs/deploy-tencent.md` 的历史记录为准；仓库配置准备完成不代表线上已切换。
