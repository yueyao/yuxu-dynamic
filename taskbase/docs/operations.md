# 数据保护与保留策略

所有命令从 `taskbase/` 执行，Node 24+。服务器的数据目录通常是 `/var/lib/taskbase`，本地默认 `.data`。

## 在线备份

```sh
node scripts/backup.ts create .data .backups/2026-11-09
node scripts/backup.ts verify .backups/2026-11-09
node scripts/backup.ts rehearse .backups/2026-11-09 /tmp/taskbase-restore-20261109
```

`create` 使用 SQLite 在线备份 API 生成包含 WAL 已提交数据的快照，再按快照中的产物清单复制文件。完成时生成 `manifest.json`，记录数据库及产物的 SHA-256；文件大小、数据库完整性和外键也会检查。目标目录必须不存在，已有备份不会被覆盖。失败时没有完整 manifest 的目录不作为可用备份。

`rehearse` 先验证备份，再复制到新的恢复目录，检查数据库可读写与产物内容；不启动 API、调度器或 Worker。该工具已使用临时数据库执行在线备份和隔离恢复回归测试。生产备份还需每月至少演练一次，并检查关键节目、稿件和产物是否符合业务预期。

数据库包含密码哈希、API Token 信息和 Web Session。备份目录为 700、文件为 600；异机备份须加密。每天备份，保留最近 14 份日备份和 8 份周备份；只有新备份及恢复演练验证成功后才轮换旧备份。调度和异机同步由部署环境配置，仓库未自动修改线上定时任务。

## 正式恢复

1. 停止 API、Web、Podcast Worker，暂停远端 Mac Worker；保留当前数据目录以便回退。
2. 使用 `verify` 和 `rehearse` 验证待恢复快照。
3. 将演练得到的新目录作为数据目录，设置正确服务用户与权限。不要只覆盖数据库而保留旧的 `-wal` / `-shm` 文件。
4. 启动 API、Web 后检查任务、单集、转写稿与产物。恢复的调度和活动队列会按原状态继续，应先审查它们，再连接 Worker。

## 日志与产物

```sh
# 默认只预览
node scripts/maintenance.ts .data
# 在确认预览并完成备份后执行
node scripts/maintenance.ts .data --apply
```

策略：

- 已结束任务的详细日志保留 30 天；活动任务日志、任务状态事件、步骤和任务结果保留。
- 数据库仍有引用的产物全部保留，包括历史任务产物；不按任务完成时间直接删除。
- 未被 `artifacts` 表引用、且修改时间超过 7 天的 UUID 产物文件可清理；近期上传、未知文件及符号链接保留。
- 脚本不会 VACUUM，删除日志释放的 SQLite 页供后续写入复用。

systemd 服务输出使用 journald。在服务器的 journald drop-in 中配置磁盘上限（例如 `SystemMaxUse=200M`、`MaxRetentionSec=30day`），nginx 日志使用系统 logrotate（每日轮换、保留 14 天并压缩）。这些设置影响服务器日志服务，应结合已有站点的保留要求应用。本次只提供策略，未修改主机配置。

## 自动检查

GitHub Actions 在 `taskbase/` 或对应 workflow 变更时执行 Node 24 类型检查、前端模块语法检查、完整测试和隔离 Chrome 页面检查。页面检查使用临时数据库与独立浏览器配置，不连接线上服务；本机可运行 `npm run smoke:web`，通过 `CHROME_PATH` 指定 Chrome 可执行文件。
