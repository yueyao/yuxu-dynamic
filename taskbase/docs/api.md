# 转写稿对外 API

更新：2026-11-09
Base URL：`http://43.156.253.152`
定位：只读查询已入库的转写稿，供外部脚本或其他系统集成。

稿件新增`version:1|2`、`diarization`和片段`speaker_id`；历史为v1，新任务为v2。列表可传`version=1|2`筛选，非法值返回400；API路径`/api/v1`不表示稿件版本。下载按transcript_id固定版本。详见[转写v2](transcription-v2.md)。

## 认证

使用 Bearer Token：

```http
Authorization: Bearer <TRANSCRIPT_API_TOKEN>
```

Token 来源：

| 位置 | 说明 |
| --- | --- |
| 本机 `taskbase/.deploy/transcript-api-token` | 原始 Token |
| 服务端 `/etc/taskbase/web.env` | `YUXUN_TRANSCRIPT_API_TOKEN`（兼容 `TASKBASE_TRANSCRIPT_API_TOKEN`，新别名优先） |

Token 错误返回 `401 UNAUTHORIZED`；平台 Owner Token 也可以用于只读查询队列和转写稿。

任务控制面 `/v1/tasks` 与调度的 input 必须是 JSON 对象，序列化后 UTF-8 不超过 65536 字节；超限返回 `413 INPUT_TOO_LARGE`。重试、调度更新及触发同样校验，平台结果和检查点保留 8 MiB HTTP 请求上限。产物上传取全局和任务定义上限的较小值，声明或实际字节超限返回 413。

## 转写队列

```http
GET /api/v1/queue
```

队列在服务端分页：`page` 默认 1，`limit` 默认 20（最多 100）；`q` 搜索节目/单集，`show_id` 按节目筛选，`status` 指定状态或 `all`。默认仅含待处理项（pending/running/failed），完整历史需传 `status=all` 并遍历所有页。返回 `total`、`page`、`pages`、`limit` 和节目筛选项 `shows`；`summary=1` 只读计数和启停状态，不返回队列项。

返回 Web 转写队列快照：

```json
{
  "counts": { "pending": 94, "running": 1, "done": 3, "failed": 0, "canceled": 0 },
  "paused": false,
  "error": null,
  "runner": false,
  "items": [
    {
      "id": "episode-id",
      "show_id": "show-...",
      "show_title": "知行小酒馆",
      "title": "单集标题",
      "status": "pending",
      "progress": 0,
      "enabled": true,
      "task_id": null
    }
  ]
}
```

认证除了转写 API Token，也接受平台 Owner Token，供本机 `yuxun ps` 读取队列。

## 列表

```http
GET /api/v1/transcripts
```

查询参数：

| 参数 | 说明 |
| --- | --- |
| `limit` | 1–100，默认 20 |
| `cursor` | 上一页返回的 `next_cursor`（数字偏移） |
| `show_id` | 按节目过滤 |
| `episode_id` | 按单集过滤 |
| `q` | 搜索单集标题 / episode id |

响应的 `total` 是当前筛选下的总数。列表只返回摘要与片段数，详情/Markdown 接口读取完整文字稿。

示例：

```sh
TOKEN="$(cat taskbase/.deploy/transcript-api-token)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://43.156.253.152/api/v1/transcripts?limit=20"
```

响应：

```json
{
  "transcripts": [
    {
      "transcript_id": "transcript-...",
      "task_id": "...",
      "episode_id": "...",
      "show_id": "...",
      "title": "单集标题",
      "language": "zh",
      "provider": "whisper-cli",
      "model": "small",
      "duration_seconds": 2388.8,
      "segments": 935,
      "created_at": "2026-11-07T11:17:50.149Z"
    }
  ],
  "next_cursor": "20"
}
```

`next_cursor` 为 `null` 表示没有下一页。

列表只返回元数据，不返回正文，适合做索引和增量同步。

## 单篇详情

```http
GET /api/v1/transcripts/:transcript_id
```

响应：

```json
{
  "transcript": {
    "transcript_id": "transcript-...",
    "task_id": "...",
    "episode_id": "...",
    "show_id": "...",
    "title": "单集标题",
    "language": "zh",
    "provider": "whisper-cli",
    "model": "small",
    "duration_seconds": 2388.8,
    "text": "完整文字稿……",
    "segments": [
      { "start": 0, "end": 8, "text": "……" }
    ],
    "artifact_id": "...",
    "created_at": "2026-11-07T11:17:50.149Z"
  }
}
```

## Markdown 下载

```http
GET /api/v1/transcripts/:transcript_id/markdown
```

返回：

```http
Content-Type: text/markdown; charset=utf-8
Content-Disposition: attachment; filename="transcript-xxxxxxxx.md"
```

示例：

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  -o transcript.md \
  "http://43.156.253.152/api/v1/transcripts/<transcript_id>/markdown"
```

Markdown 结构与 Web 转写稿一致：标题、语言、时长、引擎、文字稿、时间戳。

## Web 内下载

登录 Web 后，转写稿阅读页右上角有「下载 Markdown」，走的是同一个 Markdown 生成逻辑，使用 Web 会话认证：

```http
GET /api/transcription/transcripts/:transcript_id/markdown
```

## 数据范围

- 只读，不提供写入、删除、重跑
- 只返回服务端 `transcription_transcripts` 中已入库的记录
- Web 转写队列成功一集会自动入库
- Worker 本地不保存转写数据库；任务失败或中断不会产生记录

## 相关文档

- [Web 使用文档](web.md)
- [CLI 使用文档](cli.md)
- [架构](architecture.md)
