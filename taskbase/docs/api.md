# 转写稿对外 API

更新：2026-11-07
Base URL：`http://43.156.253.152`
定位：只读查询已入库的转写稿，供外部脚本或其他系统集成。

## 认证

使用 Bearer Token：

```http
Authorization: Bearer <TRANSCRIPT_API_TOKEN>
```

Token 来源：

| 位置 | 说明 |
| --- | --- |
| 本机 `taskbase/.deploy/transcript-api-token` | 原始 Token |
| 服务端 `/etc/taskbase/web.env` | `TASKBASE_TRANSCRIPT_API_TOKEN` |

未配置 Token 时接口返回 `503 API_DISABLED`；Token 错误返回 `401 UNAUTHORIZED`。

## 转写队列

```http
GET /api/v1/queue
```

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
