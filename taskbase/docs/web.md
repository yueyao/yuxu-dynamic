# Yuxun Web 使用文档

更新：2026-11-06
适用：远端 Taskbase Web 服务

## 1. 入口与登录

```text
http://43.156.253.152/
```

- 用户名：`owner`
- 密码：本机 `taskbase/.deploy/tencent-owner-password`

查看密码：

```sh
cat taskbase/.deploy/tencent-owner-password
```

当前入口是 HTTP，不是 HTTPS；不要在不信任的网络中登录。

## 2. 页面结构

| 页面 | 用途 |
| --- | --- |
| 总览 | 任务、节目、单集、最近采集 |
| 任务 | 所有 Platform 任务 |
| 应用 | App、任务定义、Worker Token |
| 调度 | cron 调度与运行历史 |
| 节目库 | 播客节目、单集、采集、转写 |
| 采集任务 | 播客采集任务 |
| 转写稿 | 在 Web 中阅读 Markdown |

## 3. 添加播客

进入「节目库」→「添加节目」。

支持：

- 节目页 URL
- RSS URL（有 RSS 时优先全量入库）
- 只填节目页时回退公开页，通常只有 15 集并标记 `partial`

添加后可以：

- **同步**：采集当前节目
- **采集两年**：按最近两年范围批量采集
- **单集**：查看单集
- **调度**：为该节目设置 cron
- **记录**：查看采集历史

已知 RSS 见 [RSS 来源](rss-sources.md)。

## 4. 转写

### 提交

1. 打开「节目库」
2. 点击节目的「单集」
3. 找到目标单集
4. 点击「转写」

任务会提交到远端 Platform，由 Mac 上的 Yuxun Worker 领取执行。

### 阅读转写稿

完整任务流程见 [转写全流程图](diagrams/transcription-flow.png)。

转写完成后，在单集里点击「转写稿」，会进入：

```text
/#/transcript/<episode-id>
```

这是**阅读页面**，不是下载页面：

- Markdown 标题、列表、段落、时间戳会直接渲染
- 页面显示语言、Provider、模型、时长、片段数
- 可以「复制原文」
- 不需要下载文件

转写稿页面需要登录 Web；直接打开 URL 时会先走登录。

### 任务状态

在「任务」或「采集任务」中可以看到：

- 排队
- 执行中
- 成功
- 失败/关闭
- 事件、日志和输出

如果一直 `queued`，通常是 Mac Worker 没有运行。

## 5. 调度

每个节目可以有一个 `show/sync` schedule。

当前 9 个 schedule 默认全部停用。

在「调度」页面可以：

- 启用/停用
- 修改 cron
- 查看下次触发
- 查看运行历史
- `run-now` 手动触发一次
- 删除

规则：

- 同一 schedule 有未结束任务时跳过
- 平台停机期间错过的触发不补跑
- 需要补数据时用 `run-now` 或手动同步

## 6. 应用与 Worker Token

「应用」页面可以查看：

- 已注册 App
- 任务定义
- 输入/输出 schema
- Worker Token

Token：

- 只显示一次
- 丢失后可以轮换
- Podcast Worker 和 Transcription Worker 各自独立
- Token 不能用于用户 API

## 7. 常见问题

### 登录失败

- 用户名必须是 `owner`
- 密码读 `taskbase/.deploy/tencent-owner-password`
- 连续失败会短时限流

### 页面打不开

- 确认 `http://43.156.253.152/` 可访问
- 不要用 `:3410`，该端口未在 Lighthouse 防火墙放行
- 服务器上检查 `systemctl status taskbase-web nginx`

### 提交转写后一直排队

在 Mac 上：

```sh
yuxun mac status
yuxun mac logs
```

确认 Worker 运行、Token 正确、`whisper`/`ffmpeg` 可用。

### 没有转写稿

单集还没有执行过转写，或任务失败。先看「任务」中的错误和日志。

### 转写稿显示为空

检查任务是否成功、产物是否上传；当前页面读取平台任务输出或本地转写表。

## 8. 相关文档

- [Yuxun CLI 使用文档](cli.md)
- [Yuxun Mac 服务](yuxun-mac-service.md)
- [Taskbase 使用文档索引](usage.md)
