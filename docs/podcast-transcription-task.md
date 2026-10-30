# 播客转写 Task 需求文档

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft，作为首版实现与后续演进基线 |
| 应用 | `podcast-tools` |
| Task | `audio/transcribe` |
| 完整任务名 | `podcast-tools/audio/transcribe` |
| 当前目标版本 | `transcribe-v1` |
| 最后更新 | 2026-10-30 |

本文长期维护播客转写任务的产品范围、任务契约、服务端执行流程、安全边界、恢复语义和验收标准。架构总原则见 [服务端任务设计](./server-task-design.md)：CLI 或 Web 应用只提交基本数据和播客页面链接，页面解析、音频定位、下载、转码和转写都由服务端 `podcast-tools` Worker 完成。

## 1. 背景与目标

用户拥有一个公开可访问的播客单集网页，例如小宇宙播客单集页面，希望提交网页链接后获得可下载、可追溯的文字稿。

首版目标：

- 用户只需要提供播客单集网页 URL 和少量转写选项。
- Worker 自动识别来源平台、解析单集元数据并定位真实音频。
- Worker 在服务端完成音频下载、格式处理、分片、转写和合并。
- 长音频任务持续上报进度，并在 Worker 中断后从已确认步骤恢复。
- 最终生成一份 Markdown 或纯文本产物，并返回结构化摘要。
- 来源解析器、下载逻辑和转写引擎都可以随 Worker 版本独立升级，不要求升级 CLI。

## 2. 非目标

首版不包含：

- 用户上传本地音频文件。
- 绕过登录、付费墙、DRM、验证码或平台访问控制。
- 私有播客、需要 Cookie 的内容或账号授权内容。
- 播客订阅、自动监控新单集和批量历史回填。
- 自动摘要、章节提取、标题生成、翻译或内容审校。
- 同时输出 Markdown、TXT、SRT、VTT 等多个产物。
- 在 CLI、Web 页面或共享平台 API 中实现网页抓取、转码或语音识别。

摘要、章节和翻译应作为独立 Task，以本任务产出的文字稿为输入，避免与转写的失败恢复、版本和成本耦合。

## 3. 用户流程

### CLI

```sh
yuxu task run podcast-tools/audio/transcribe \
  --input-json '{
    "source_url":"https://www.xiaoyuzhoufm.com/episode/example",
    "language":"auto",
    "timestamps":"segment",
    "speaker_diarization":false,
    "output_format":"markdown",
    "quality":"balanced"
  }' \
  --idempotency-key podcast-example-v1 \
  --wait
```

### Web 应用

Web 页面提供 URL 输入框和转写选项。应用后端使用同一用户 API 提交任务，页面只展示任务状态、进度、日志摘要和最终下载入口。浏览器不直接访问目标播客页面，不持有 Worker Token，也不调用转写服务。

## 4. 角色与职责

| 组件 | 职责 |
| --- | --- |
| CLI / Web | 收集 URL 和选项，提交、查询、展示和下载结果 |
| 共享平台 | 认证、schema 校验、幂等、排队、租约、检查点、日志、结果和产物 |
| Podcast Worker | 识别平台、解析网页、定位音频、下载、转码、切片、转写、合并和上传产物 |
| 来源适配器 | 封装特定播客平台的 URL 识别、规范化、元数据和媒体定位逻辑 |
| 转写引擎适配器 | 封装具体本地模型或第三方语音识别服务 |

共享平台不理解“小宇宙页面结构”或“音频播放地址”。这些知识属于 `podcast-tools` Worker 的来源适配器。

## 5. 输入契约

### JSON 示例

```json
{
  "source_url": "https://www.xiaoyuzhoufm.com/episode/example",
  "language": "auto",
  "timestamps": "segment",
  "speaker_diarization": false,
  "output_format": "markdown",
  "quality": "balanced"
}
```

### 字段

| 字段 | 必填 | 取值 | 语义 |
| --- | --- | --- | --- |
| `source_url` | 是 | HTTPS URL，最长 2048 字符 | 公开播客单集网页，不是音频直链 |
| `language` | 否 | `auto`、`zh`、`en` | 默认 `auto` |
| `timestamps` | 否 | `none`、`segment` | 默认 `segment` |
| `speaker_diarization` | 否 | boolean | 默认 `false`；首版可在引擎不支持时明确拒绝 |
| `output_format` | 否 | `text`、`markdown` | 默认 `markdown` |
| `quality` | 否 | `fast`、`balanced`、`accurate` | 默认 `balanced`；映射由 Worker 版本决定 |

公共契约不暴露供应商模型名、API key、FFmpeg 参数、分片长度或并发数。这些属于 Worker 版本和部署配置。

### 建议 manifest

```json
{
  "app_id": "podcast-tools",
  "release_digest": "transcribe-v1",
  "max_concurrency": 1,
  "tasks": [{
    "task_key": "audio/transcribe",
    "timeout_ms": 21600000,
    "max_attempts": 3,
    "input_schema": {
      "type": "object",
      "required": ["source_url"],
      "additionalProperties": false,
      "properties": {
        "source_url": {
          "type": "string",
          "minLength": 12,
          "maxLength": 2048,
          "pattern": "^https://"
        },
        "language": {
          "type": "string",
          "enum": ["auto", "zh", "en"]
        },
        "timestamps": {
          "type": "string",
          "enum": ["none", "segment"]
        },
        "speaker_diarization": { "type": "boolean" },
        "output_format": {
          "type": "string",
          "enum": ["text", "markdown"]
        },
        "quality": {
          "type": "string",
          "enum": ["fast", "balanced", "accurate"]
        }
      }
    },
    "output_schema": {
      "type": "object",
      "required": [
        "artifact_id",
        "source_platform",
        "canonical_url",
        "title",
        "language",
        "duration_seconds",
        "segment_count",
        "format"
      ],
      "additionalProperties": false,
      "properties": {
        "artifact_id": { "type": "string", "minLength": 1 },
        "source_platform": { "type": "string", "minLength": 1 },
        "canonical_url": { "type": "string", "minLength": 1 },
        "source_episode_id": { "type": "string" },
        "title": { "type": "string", "minLength": 1 },
        "language": { "type": "string", "minLength": 2 },
        "duration_seconds": { "type": "number", "minimum": 0 },
        "segment_count": { "type": "integer", "minimum": 0 },
        "format": { "type": "string", "enum": ["text", "markdown"] },
        "audio_sha256": { "type": "string" }
      }
    }
  }]
}
```

当前 schema 子集没有默认值表达能力，Worker 对省略字段应用上述默认值。`timeout_ms` 和并发上限在实际部署前根据最长允许音频和转写引擎性能调整。

## 6. 来源适配器

Worker 通过来源适配器处理不同播客平台，通用接口至少应提供：

```ts
type ResolvedEpisode = {
  platform: string;
  canonicalUrl: string;
  episodeId?: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  mediaUrl: string;
  mediaContentType?: string;
  declaredDurationSeconds?: number;
};
```

首版要求：

- 支持公开的小宇宙单集页面 URL。
- 识别常见分享 URL 和跳转后 URL，并保存最终规范化页面 URL。
- 从页面或公开接口中取得单集标题、平台单集 ID 和音频地址。
- 音频地址若是短期 URL，恢复时允许重新解析页面，但必须校验最终音频内容摘要。
- 页面结构变化时返回明确的来源解析错误，不得把空页面或错误页当作音频。

新增来源平台时增加独立适配器，不修改 CLI 命令和共享平台 API。

## 7. 服务端执行流程

### 阶段一：校验和解析来源

1. 校验 `source_url` 是 HTTPS URL。
2. 根据 host 选择已启用的来源适配器。
3. 限制重定向次数，并对每次目标重新执行网络安全检查。
4. 取得规范化页面 URL、平台、单集 ID、标题和音频地址。
5. 保存 `source-resolved` 检查点。

### 阶段二：取得音频

1. 以流式方式下载音频，不把完整文件读入内存。
2. 限制响应大小、下载时间、空闲超时和允许的媒体类型。
3. 下载过程中计算 SHA-256。
4. 使用媒体探测工具读取真实格式、时长、声道和采样率。
5. 保存 `audio-acquired` 检查点，包括音频摘要、时长和服务端工作资源引用。

服务端工作资源由 Worker 创建，可以保存在任务工作目录或内部对象存储。它不是客户端上传资产，也不改变原始任务输入。若工作资源无法跨 Worker 实例保留，恢复时可以重新下载，但内容摘要必须与已确认来源快照一致。

### 阶段三：标准化与切片

1. 转换为转写引擎支持的统一格式。
2. 按固定时间或音频静音边界切片。
3. 为每个片段生成稳定索引、起止时间和内容摘要。
4. 保存 `audio-segmented` 检查点。

### 阶段四：分片转写

1. 对未完成片段调用转写引擎。
2. 第三方请求使用 `task_id + segment_index + release_digest` 作为稳定幂等键或请求标识。
3. 每个成功片段保存不可变检查点 `segment-000001`、`segment-000002` 等。
4. 检查点保存文本、时间范围、语言、说话人信息和引擎请求 ID，不保存音频字节。
5. 根据完成片段数持续上报进度。

### 阶段五：合并与产物

1. 按时间顺序合并片段。
2. 处理切片边界产生的重复文字和时间重叠。
3. 生成 Markdown 或纯文本。
4. 上传最终文字稿。
5. 提交结构化结果并将任务置为成功。

## 8. 输出契约

```json
{
  "artifact_id": "artifact_xxx",
  "source_platform": "xiaoyuzhou",
  "canonical_url": "https://www.xiaoyuzhoufm.com/episode/example",
  "source_episode_id": "example",
  "title": "访谈节目第 12 期",
  "language": "zh",
  "duration_seconds": 3725,
  "segment_count": 186,
  "format": "markdown",
  "audio_sha256": "..."
}
```

Markdown 产物建议格式：

```text
# 访谈节目第 12 期

- 来源：小宇宙
- 原页面：https://...
- 音频时长：01:02:05
- 转写语言：zh

## 文字稿

[00:00:03 - 00:00:12] Speaker 1
欢迎收听本期节目……
```

首版只有一个最终 `artifact_id`。字幕、多格式文本和来源音频缓存均不作为对用户公开的最终产物。

## 9. 状态、进度和恢复

推荐进度：

| 进度 | 阶段 |
| --- | --- |
| 0–5% | 识别来源、处理跳转和解析页面 |
| 5–15% | 下载和验证音频 |
| 15–20% | 转码和切片 |
| 20–90% | 分片转写 |
| 90–97% | 合并、去重和格式化 |
| 97–100% | 上传产物并提交结果 |

恢复要求：

- Worker 中断后由平台租约机制把任务转为 `recovering`。
- 新尝试复用已确认的来源、音频和片段检查点。
- 来源页面重新解析后若音频摘要改变，不得静默把两个版本拼接；应重新开始音频相关步骤或以明确错误失败。
- 旧尝试不能继续写进度、片段或最终结果。
- 最终产物在每次有效尝试中重新生成和上传，避免引用失败尝试的临时文件。

## 10. 错误语义

目标错误分类：

| 错误码 | 场景 | 是否适合重试 |
| --- | --- | --- |
| `INVALID_SOURCE_URL` | URL 不是合法 HTTPS 单集页面 | 否 |
| `UNSUPPORTED_SOURCE` | 没有匹配的来源适配器 | 否 |
| `SOURCE_NOT_FOUND` | 页面或单集不存在 | 否 |
| `SOURCE_ACCESS_DENIED` | 需要登录、付费或被平台拒绝 | 否，除非授权方式改变 |
| `SOURCE_RATE_LIMITED` | 来源平台限流 | 是，退避后重试 |
| `SOURCE_PARSE_FAILED` | 页面结构变化或缺少音频信息 | 发布适配器修复后重试 |
| `MEDIA_DOWNLOAD_FAILED` | 网络中断或媒体响应失败 | 是 |
| `MEDIA_TOO_LARGE` | 超过配置的大小或时长限制 | 否 |
| `MEDIA_UNSUPPORTED` | 实际媒体格式无法处理 | 否 |
| `TRANSCRIPTION_FAILED` | 转写引擎失败 | 视引擎错误分类决定 |
| `OUTPUT_TOO_LARGE` | 文字稿超过当前产物限制 | 否，需调整平台限制或输出策略 |

当前平台的失败接口只接收字符串；实现首版时可以用稳定错误码作为消息前缀，后续平台增加结构化错误字段后再迁移。

## 11. 网络与安全要求

- 首版只启用明确配置的来源适配器和 host，不提供任意 URL 抓取代理。
- 解析和下载前后都要解析 DNS，拒绝环回、私网、链路本地、保留地址和云元数据地址。
- 每次重定向都重新校验 scheme、host、DNS 和地址范围，并限制最大跳转次数。
- 只允许 HTTP 响应中的预期页面和媒体内容类型；媒体探测结果是最终判断依据。
- 设置连接、首字节、空闲和总下载超时，并限制最大下载字节和最大音频时长。
- 不绕过登录、付费墙、DRM、验证码或来源平台的访问控制。
- 转写引擎凭据仅存在于 Worker 环境变量或密钥管理器中。
- 日志不得包含签名音频 URL、Cookie、Authorization、API key 或完整第三方错误响应。
- 如果使用第三方转写服务，应明确音频数据的传输区域、保留策略和隐私风险。

## 12. 配置项

建议由 Worker 部署配置提供：

| 配置 | 说明 |
| --- | --- |
| `PODCAST_SOURCE_ADAPTERS` | 启用的来源适配器列表 |
| `PODCAST_ALLOWED_HOSTS` | 允许的页面和媒体 host 范围 |
| `PODCAST_MAX_AUDIO_BYTES` | 最大下载字节数 |
| `PODCAST_MAX_DURATION_SECONDS` | 最大音频时长 |
| `PODCAST_DOWNLOAD_TIMEOUT_MS` | 总下载超时 |
| `PODCAST_SEGMENT_SECONDS` | 默认切片长度 |
| `PODCAST_WORK_DIR` | 临时工作目录 |
| `TRANSCRIPTION_PROVIDER` | 转写引擎适配器名称 |
| `TRANSCRIPTION_MODEL` | 服务端模型配置，不进入用户输入 |
| `TRANSCRIPTION_CONCURRENCY` | 单任务内片段并发数 |

实际变量名在实现时固定，并同步更新部署说明。敏感值不得写入仓库。

## 13. 可观测性

任务日志至少记录：

- 已识别的平台和规范化页面 URL。
- 来源解析、下载、探测、切片、转写和合并阶段的开始与完成。
- 音频时长、片段总数和已完成片段数。
- 可重试错误的分类和下一步处理，不记录秘密或短期媒体 URL。

建议指标：

- 来源解析成功率和耗时。
- 音频下载成功率、字节数和耗时。
- 每音频分钟的转写耗时和费用。
- 分片失败率和重试次数。
- Worker 租约过期与恢复次数。
- 文字稿字数和产物上传失败率。

## 14. 验收标准

首版完成条件：

1. 用户仅提交一个公开小宇宙单集 URL 即可创建任务，不需要上传音频。
2. Worker 能识别来源、取得标题和音频，并把规范化来源信息保存为检查点。
3. 长音频采用流式下载和分片处理，不把整个文件长期驻留内存。
4. CLI `task watch` 能看到来源解析、下载、切片和转写进度。
5. 任务成功后可通过 `artifact download` 获得完整 Markdown 文字稿。
6. 中断 Worker 后，任务进入 `recovering`，新 Worker 不重复已确认的转写片段。
7. 旧尝试无法提交进度或覆盖最终结果。
8. 重复使用同一幂等键和相同输入返回原任务；URL 或选项改变时返回幂等冲突。
9. 不支持的平台 URL、登录内容、失效页面和过大音频返回可诊断错误。
10. 指向内网、云元数据或危险重定向的 URL 被拒绝，且没有产生出站访问。
11. 日志和任务结果中不出现 Cookie、签名媒体 URL 或转写服务密钥。
12. `npm test` 和类型检查覆盖任务输入 schema、来源适配器、恢复和错误分类的关键行为。

## 15. 演进路线

### V1：公开小宇宙单集转写

- URL 输入。
- 单一小宇宙来源适配器。
- Markdown 或纯文本单产物。
- 可恢复分片转写。

### V1.1：更多来源与字幕

- 增加其他公开播客平台和 RSS enclosure 适配器。
- 支持 SRT/VTT 和多产物。
- 改进说话人区分。

### V2：工作流与自动化

- 转写完成后触发摘要、章节和翻译任务。
- 订阅源新单集自动触发。
- 允许用户授权的私有来源，但不绕过来源平台权限。

## 16. 待决策项

- 首版使用本地模型还是第三方转写服务。
- 小宇宙来源适配器使用公开页面解析还是稳定的公开数据接口。
- 服务端下载的原始音频是否缓存到对象存储，以及保留期限。
- 首版允许的最大音频时长和文件大小。
- `speaker_diarization=true` 在引擎不支持时是拒绝任务还是降级并警告。
- 文字稿超过 5 MiB 时采用提高产物上限、压缩还是分卷输出。

待决策项确认后，应更新本文对应章节，并在下方决策记录中增加日期和结论。

## 17. 决策记录

| 日期 | 决策 | 原因 |
| --- | --- | --- |
| 2026-10-30 | 首版输入为公开播客单集网页 URL，不要求客户端上传音频 | 客户端只提供任务基本数据；页面解析和资源获取属于服务端任务逻辑 |
| 2026-10-30 | 共享平台不实现通用播客抓取，来源适配器属于 `podcast-tools` Worker | 保持平台语言无关和领域无关，允许 Worker 独立发布 |
| 2026-10-30 | 首版只返回一份文字稿产物 | 匹配当前单产物能力，先验证完整任务闭环 |

