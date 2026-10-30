# 任务底座调用与状态契约

本文描述当前已实现的本地底座。CLI 和应用后端使用同一套用户侧 `/v1` HTTP/JSON 接口；Worker 通过独立的服务令牌调用 `/v1/worker`。业务代码只在应用 Worker 中运行。新任务的客户端、平台控制面和服务端执行面边界见 [服务端任务设计](./server-task-design.md)。

## 1. 提交与调度

用户侧先用 `POST /v1/auth/cli-token` 登录。随后调用：

```http
POST /v1/tasks
Authorization: Bearer <用户令牌>
Idempotency-Key: report-2026-10-26
Content-Type: application/json

{"task":"example-app/report/build","input":{"title":"日报"},"run_at":"2026-10-26T08:00:00+08:00"}
```

`run_at` 可省略，省略时立即可领取；设置时必须是带时区的 ISO 8601 时间，且创建时在未来一年内。这是**单次计划执行**，不是周期性 cron。平台在一个 SQLite 事务中写入任务和首个事件，返回 `202` 与任务 ID。相同用户、应用、任务键和 `Idempotency-Key` 重新提交相同输入、相同计划时间，会返回原任务和 `200`；输入或计划时间不同返回 `409 IDEMPOTENCY_CONFLICT`。计划时间过去后重试原请求仍会复用原任务。

Worker 调用 `POST /v1/worker/leases`。平台检查 Worker 所属应用和发布摘要、应用并发上限、计划时间、总截止时间，然后在事务内创建尝试和租约。到点前或没有可用任务时返回 `204`。本地版通过 Worker 轮询调度，API 内的回收器处理过期租约和超时任务；没有独立定时服务。任务总时限从 `run_at` 开始计算；立即任务从创建时开始计算。

## 2. 结果、历史与日志

| 接口 | 当前语义 |
| --- | --- |
| `GET /v1/tasks/{id}` | 完整任务快照，含状态、进度、计划时间、截止时间、输出或错误 |
| `GET /v1/tasks/{id}/result` | `queued/running/recovering` 返回 HTTP `202` 和当前状态；`succeeded/failed` 返回 HTTP `200`、输出、产物 ID 或错误 |
| `GET /v1/tasks?app_id=...&task_key=...&status=...&limit=20&cursor=...` | 任务历史，按 `(created_at, id)` 倒序；`limit` 为 1–100，返回 `tasks` 和下一页 `next_cursor` |
| `GET /v1/tasks/{id}/events?after=0` | 状态、进度、步骤、产物和日志事件；每页最多 100 条 |
| `GET /v1/tasks/{id}/logs?after=0` | 仅日志，包含级别、消息、尝试 ID、时间和事件 ID；每页最多 100 条 |
| `GET /v1/artifacts/{id}/download` | 下载成功任务的最终文件产物，平台验证文件大小与摘要 |

事件与日志的 `after` 是**严格大于**上次 ID 的游标。客户端取最后一条 ID 作为下一次 `after`，无需依赖时间戳。历史列表的游标是 opaque 字符串，应直接传回，不解析或修改。所有用户侧接口都要求用户令牌；Worker 令牌无法读取任务历史或结果。当前平台只有一个所有者，尚无多用户细粒度授权。

Worker 可调用 `POST /v1/worker/tasks/{id}/logs`，请求需带 Worker 令牌和 `X-Attempt-Id`，正文为 `{"level":"info","message":"..."}`。级别为 `debug/info/warn/error`，消息最长 2000 字符。租约失效或旧尝试的日志返回 `409 STALE_ATTEMPT`。进度、日志和步骤事件持久化到 SQLite；API 同时在标准输出写一条不含请求体、查询参数及令牌的结构化请求日志。任务代码不得把秘密写入日志消息。

## 3. CLI 与应用后端

```sh
npm run yuxu -- task run example-app/report/build --input .local/input.json
npm run yuxu -- task run example-app/report/build --input .local/input.json --run-at 2026-10-26T08:00:00+08:00 --idempotency-key daily-report
npm run yuxu -- tasks history --app example-app --status succeeded --limit 20
npm run yuxu -- task result TASK_ID
npm run yuxu -- task logs TASK_ID --after 0
npm run yuxu -- task watch TASK_ID
```

`tasks list <app-id>` 列出**任务定义**，`tasks history` 列出**历史任务实例**。`task watch` 从事件游标轮询，终态时打印结构化结果；文件产物仍用 `artifact download` 取得。

应用后端可导入 [`PlatformClient`](../packages/client-sdk/src/index.ts)：

```ts
const client = new PlatformClient({ baseUrl: platformUrl, token: userToken });
const { task } = await client.submitTask('example-app/report/build', { title: '日报' });
const result = await client.getResult(task.task_id);
const page = await client.listTasks({ appId: 'example-app', limit: 20 });
const logs = await client.getLogs(task.task_id);
if (result.artifact_id) {
  const artifact = await client.downloadArtifact(result.artifact_id);
}
```

当前没有 Web 登录会话。独立 Web 页面应通过自己的后端持有并使用用户令牌，由后端调用平台 API；不要把 Worker 令牌放入浏览器。Web 会话、跨应用权限和管理台仍属于后续阶段。

## 4. 当前范围

目前支持单次计划执行、持久化历史、事件和 Worker 日志、结构化 JSON 结果与文件产物、租约恢复、幂等提交。周期性计划、取消、手动重试、webhook、审计库、Web 会话和跨机器部署尚未实现。平台依然基于本机 SQLite 和文件目录；无 Worker 匹配时任务会一直等待，直到总截止时间触发失败。
