# 播客转写 Task 技术调研与实施建议

| 项目 | 内容 |
| --- | --- |
| 状态 | Accepted，作为首版技术选型和实现顺序的依据 |
| 适用任务 | `podcast-tools/audio/transcribe` |
| 关联需求 | [播客转写 Task 需求](./podcast-transcription-task.md) |
| 架构边界 | [服务端任务设计](./server-task-design.md) |
| 最后更新 | 2026-10-30 |

本文记录公开播客链接解析、音频获取、预处理、语音转写、时间戳和说话人分离方案的调研结果，并给出适合玉虚任务平台的首版实现建议。本文维护技术事实、候选方案和选型理由；产品输入输出、错误语义与验收标准以播客转写 Task 需求为准。

## 1. 结论摘要

首版不应把现有播客转写工具整体嵌入共享平台，也不应让 CLI 或 Web 应用下载和上传播客音频。推荐实现为独立的 `podcast-tools` 服务端 Worker：

```text
公开播客单集 URL
  → SourceAdapter 解析页面并定位音频
  → 受控流式下载、摘要计算和 ffprobe 探测
  → ffmpeg 标准化及按语音边界切片
  → TranscriptionProvider 转写未完成片段
  → 持久化片段检查点
  → 合并、边界去重和格式化
  → 上传文字稿产物并提交结构化结果
```

首版选择：

- 来源解析采用“小宇宙专用适配器 + 通用 RSS/HTML 回退”的分层方式。
- 小宇宙专用适配器优先解析页面 `__NEXT_DATA__` 中的单集数据，再回退到 `og:audio`。
- 音频必须由 Worker 流式下载，不得完整读入内存；下载时计算 SHA-256，并用 `ffprobe` 判断真实格式和时长。
- 转写引擎通过能力可声明的 `TranscriptionProvider` 接口隔离；第一个云端接入候选为 ElevenLabs Scribe v2。
- 在中文播客样本评测完成前，不把任何云服务写死为最终生产默认；自托管方案重点评测 FunASR，faster-whisper 作为通用基线。
- V1 的 `speaker_diarization` 默认关闭。分片内的 `speaker_0` 不能直接视为整期播客中的同一个人，全局说话人分离需要单独设计。
- Worker 通过平台检查点恢复，不复用 Podforge 等本地工具的进程内工作流。

## 2. 调研范围与判断标准

本次调研覆盖：

1. 从小宇宙等公开播客单集网页定位真实音频。
2. 长音频下载、探测、标准化、切片和中断恢复。
3. 中文语音识别、时间戳、说话人分离和长文件处理。
4. 开源本地部署与第三方 API 的接入成本、隐私和运维差异。
5. 与当前玉虚平台任务、检查点、产物和 Worker SDK 的衔接方式。

选择方案时优先考虑：

- 公开页面解析的稳定性和失败可诊断性。
- 中文访谈、专有名词和中英文混说的准确率。
- 长音频内存占用、超时、恢复和重复计费风险。
- 分段或词级时间戳能力。
- 说话人标签是否是全局一致的匿名聚类，而非仅在一个切片内有效。
- 数据是否离开 Worker、第三方保留策略及部署复杂度。
- 能否封装在应用 Worker 内，而不把供应商知识泄漏到 CLI 和共享平台。

## 3. 参考项目：Podforge

[Podforge](https://github.com/dairui1/podforge) 是一个 MIT 许可证的 TypeScript 播客下载与转写 CLI，支持小宇宙、Apple Podcasts、YouTube 和常见公开播客页面。它是本次调研中与目标流程最接近的开源实现。

值得借鉴的设计：

- 使用独立 `SourceAdapter` 封装各平台页面解析，并在最后提供通用 HTML/RSS 回退。
- 使用独立 STT Provider 抽象 MLX Whisper、ElevenLabs 和多个远程服务。
- 将解析、下载、切片、逐片转写、时间偏移和产物写入组织成明确工作流。
- 通过事件报告解析、下载、切片和转写进度。

不应原样采用的部分：

- 当前下载逻辑先把完整响应转换为内存 Buffer，再写入文件，不适合服务器处理长音频。
- 小宇宙及通用页面中的部分 HTML 提取依赖正则表达式，对属性顺序、转义和页面改版较敏感。
- FFmpeg 使用固定时长、无重叠、`-c copy` 切片；实际切点可能受容器关键点影响，也可能切断句子。
- 逐片转写结果只存在于单次进程，缺少跨 Worker 的持久化检查点、租约隔离和恢复语义。
- 音频获取、转写和本地文件产物围绕单机 CLI 设计，没有玉虚平台的 SSRF 防护、产物接口和任务版本约束。

因此，Podforge 适合作为 Adapter/Provider 分层和页面解析路径的参考，不作为玉虚 Worker 的运行依赖。玉虚应按自己的 Worker SDK、错误契约和恢复模型重新实现。

## 4. 小宇宙来源解析

### 4.1 已验证页面结构

Podforge 的[小宇宙来源适配器](https://github.com/dairui1/podforge/blob/main/src/sources/xiaoyuzhou.ts)按以下顺序提取数据：

1. 读取页面中的 `script#__NEXT_DATA__` JSON。
2. 从 `props.pageProps.episode` 或脱水查询状态中寻找单集对象。
3. 优先读取 `episode.enclosure.url`。
4. 其次读取 `episode.media.source.url`。
5. 如果单集对象没有媒体地址，回退到页面 `meta[property="og:audio"]`。

2026-10-30 使用公开小宇宙单集页面做过只读验证：样本页面同时包含 `__NEXT_DATA__`、`og:audio` 和同一 `media.xyzcdn.net` 音频地址；对该音频执行单字节 Range 请求返回 `206 Partial Content`、`audio/mp4` 和完整文件长度，样本请求不需要 Cookie。该结果只能证明当前公开样本可用，不能承诺所有节目、未来页面结构或 CDN 权限策略不变。

### 4.2 玉虚解析策略

建议定义：

```ts
interface SourceAdapter {
  readonly name: string;
  canResolve(url: URL): boolean;
  resolve(input: ResolveSourceInput): Promise<ResolvedEpisode>;
}

interface ResolvedEpisode {
  platform: string;
  canonicalUrl: string;
  episodeId?: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  mediaUrl: string;
  mediaContentType?: string;
  declaredDurationSeconds?: number;
  resolverVersion: string;
}
```

`XiaoyuzhouSourceAdapter` 的解析顺序：

```text
规范化并校验单集 URL
  → 获取公开 HTML
  → 用 HTML Parser 定位 __NEXT_DATA__
  → 从已知路径读取 episode
  → enclosure.url / media.source.url
  → og:audio 回退
  → 通用 RSS enclosure 回退
  → SOURCE_PARSE_FAILED
```

实现要求：

- 使用 HTML Parser 读取脚本和 meta，不使用依赖属性顺序的正则表达式解析完整页面。
- JSON 字段读取必须容忍缺失字段，但只接受经过 URL、scheme 和 host 校验的媒体地址。
- 保存页面最终 URL、平台单集 ID、标题、解析器版本和必要的非敏感响应元数据。
- 媒体 URL 可能带签名或变化，不写入用户可见日志和最终结果。
- 恢复时可以重新解析页面；若下载后 SHA-256 与已确认来源快照不一致，不得继续拼接旧片段。
- 专用适配器失败时，只有结构确实满足通用 HTML/RSS 规则才允许回退，不能把错误页误认为播客页面。

### 4.3 不采用的路径

- 不依赖 CLI 或浏览器解析页面，因为这会让客户端版本与来源平台页面结构绑定。
- 不把 `yt-dlp` 作为小宇宙首版依赖；当前没有找到其官方小宇宙 extractor 的可靠依据。
- 不调用来源平台的非公开移动端接口，不绕过登录、付费、验证码、DRM 或访问控制。
- 不将通用任意 URL 抓取器放入共享平台 API；来源解析仍属于 `podcast-tools` Worker。

## 5. 音频获取与预处理

### 5.1 下载

下载器应：

- 对页面 URL、每次重定向和最终媒体 URL 执行 SSRF 检查。
- 使用流式管道写入任务工作目录或内部对象存储，同时计算 SHA-256 和已下载字节数。
- 限制重定向次数、最大字节数、连接超时、首字节超时、空闲超时和总耗时。
- 支持 Range 不是首版前置条件，但应保存 `ETag`、`Last-Modified`、`Content-Length` 等非敏感信息，为断点下载和来源变化判断留出空间。
- 不只相信扩展名和 `Content-Type`，下载后必须通过媒体探测确认格式和时长。

### 5.2 标准化

使用 `ffprobe` 获取：

- 容器和音频编码。
- 实际时长、采样率、声道数和比特率。
- 是否存在无法处理的流或异常时长。

转写工作副本使用 Provider 支持的统一格式。对云端上传优先考虑 16 kHz 单声道 FLAC，以降低体积；对本地模型可以按其运行时要求提供 PCM/WAV 或解码后的张量。原始下载文件和标准化工作文件均属于服务端临时资源，不是客户端上传资产。

### 5.3 切片

不建议直接复用固定 300 秒、无重叠的 `-c copy` 切片。推荐：

1. 使用 VAD 或静音检测寻找目标长度附近的自然边界。
2. 设置最大片段时长，避免长时间无静音导致超出 Provider 限制。
3. 保留约 0.5–1.5 秒重叠，合并时依据时间和文本相似度去重。
4. 每个片段记录稳定索引、源音频时间范围、文件摘要和切片算法版本。
5. 所有时间戳统一使用相对原始音频起点的毫秒整数。

具体目标时长和重叠长度由实际 Provider 限制及评测决定，不暴露给 CLI 用户。

## 6. 转写引擎调研

### 6.1 候选对比

| 方案 | 部署方式 | 时间戳 | 说话人分离 | 中文与长音频判断 | 主要取舍 |
| --- | --- | --- | --- | --- | --- |
| [ElevenLabs Scribe v2](https://elevenlabs.io/docs/capabilities/speech-to-text) | SaaS | 词级 | 支持，最多 32 位说话人 | 官方列出普通话并支持大文件；播客准确率需自测 | 接入快、返回结构完整；音频离开 Worker 并按量付费 |
| [Deepgram Nova-3](https://developers.deepgram.com/docs/models-languages-overview) | SaaS | 词级/段级 | [支持](https://developers.deepgram.com/docs/diarization) | 官方列出简体普通话、繁体普通话和粤语 | API 成熟；中文专有名词和成本需实测 |
| [OpenAI Speech to text](https://platform.openai.com/docs/guides/speech-to-text) | SaaS | 取决于模型与输出格式 | 提供 diarize 模型 | 接入简单；模型文件限制和中文效果需基准验证 | 生态统一；需要适配不同模型的输出契约 |
| [AssemblyAI](https://www.assemblyai.com/docs/speech-to-text/speaker-diarization) | SaaS | 词级/utterance | 支持 | 能处理远程文件并给出说话人 utterance；中文能力需单独确认和实测 | 功能完整；不是当前优先候选 |
| [FunASR](https://github.com/modelscope/FunASR) | 自托管 | 模型相关，Paraformer 支持时间戳 | 可组合 FSMN-VAD、CAM++ 和标点模型 | 面向中文的模型及链路丰富 | 中文优先候选；Python/GPU、模型版本和许可证运维更复杂 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 自托管 | 支持词级 | 需组合其他模型 | Whisper 多语言通用基线，内置 Silero VAD 与批量推理 | MIT、成熟；不原生提供全局说话人分离 |
| [WhisperX](https://github.com/m-bain/whisperX) | 自托管组合 | 强词级对齐 | 组合 pyannote | 中文需要合适的语言对齐模型 | 时间戳强；依赖链和 GPU 部署更复杂 |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 自托管或服务 | 不负责 ASR | `community-1` 支持离线分离 | 与语言基本解耦 | 适合全局说话人聚类；需单独下载模型和接受模型条款 |

表中“支持”只代表官方接口或项目具备相应能力，不代表在中文播客上的准确率已经达到生产要求。

### 6.2 推荐顺序

首个端到端版本优先接入 ElevenLabs Scribe v2，理由是其一个接口即可返回文本、词级时间戳、语言和可选说话人标签，并能较快验证玉虚 Task 的链接解析、长任务、检查点和产物闭环。

同时保留以下评测路径：

- Deepgram Nova-3：云端替代候选。
- FunASR：中文自托管首选候选。
- faster-whisper：自托管通用基线，用于衡量云服务收益。

生产默认 Provider 必须在中文播客基准测试后决定，不能由 README、厂商宣称或单条样本决定。

## 7. Provider 契约

Provider 需要显式声明能力和限制，避免 Worker 用供应商名称写分支：

```ts
type TimestampGranularity = "none" | "segment" | "word";

interface TranscriptionCapabilities {
  timestamps: TimestampGranularity[];
  diarization: boolean;
  languageDetection: boolean;
  supportedLanguages?: string[];
  maxFileBytes?: number;
  maxDurationSeconds?: number;
  acceptsRemoteUrl: boolean;
}

interface TranscriptionInput {
  audioPath: string;
  language?: "auto" | "zh" | "en";
  timestamps: TimestampGranularity;
  diarization: boolean;
  requestKey: string;
}

interface TranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  confidence?: number;
}

interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  words?: TranscriptWord[];
}

interface TranscriptionProvider {
  readonly name: string;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]>;
}
```

统一契约还应保存 Provider 请求 ID、Provider/模型版本、检测语言和耗时，但这些执行元数据不全部暴露给最终用户。API key、原始错误响应和带签名的供应商 URL 不得进入检查点。

## 8. 说话人分离的边界

说话人分离需要回答“谁在什么时候说话”，但匿名标签通常只在一次模型调用范围内稳定：

```text
片段 1 的 speaker_0 ≠ 必然等于片段 2 的 speaker_0
```

因此不能简单并行切片、分别 diarize 后直接拼接标签。可选路线：

1. 将完整音频交给支持长文件和全局 diarization 的 Provider，再按 Provider 的异步任务恢复。
2. 先完成完整音频的全局说话人聚类，再把全局说话人时间区间映射到分片转写词语。
3. 对重叠片段提取 speaker embedding 并做跨片段聚类；该方案实现和验证成本最高。

V1 默认 `speaker_diarization=false`。若用户显式传入 `true` 而当前部署 Provider 不支持全局一致标签，Worker 应以稳定错误码拒绝，不能静默降级或返回误导性标签。

## 9. 玉虚 Worker 设计

### 9.1 模块划分

```text
podcast-tools worker
├── task-handler
├── sources
│   ├── xiaoyuzhou
│   └── generic-rss
├── media
│   ├── safe-fetch
│   ├── downloader
│   ├── probe
│   └── segmenter
├── transcription
│   ├── provider
│   ├── elevenlabs
│   ├── deepgram       # 后续
│   └── funasr         # 后续
├── transcript
│   ├── merge
│   └── markdown
└── errors
```

共享平台只看见任务输入、检查点、进度、日志、产物和结构化输出，不理解上述领域模块。

### 9.2 检查点

建议使用以下稳定步骤名：

```text
source-resolved
audio-acquired
audio-normalized
segments-planned
segment-000001
segment-000002
...
transcript-merged
artifact-uploaded
```

片段检查点至少保存：

- 片段索引、原音频起止毫秒和片段 SHA-256。
- 文本、段级时间戳、可选词级时间戳和可选说话人标签。
- Provider 请求 ID、Provider/模型版本和完成时间。
- 合并所需的片段头尾少量文本，不保存音频字节。

恢复时读取已确认检查点，跳过已完成片段。第三方请求使用 `task_id + release_digest + segment_index + segment_sha256` 生成稳定请求键；若供应商不支持真正的幂等键，Worker 仍应记录请求 ID 并在重试前查询已有结果或采用本地去重策略。

### 9.3 进度

沿用需求文档中的阶段映射：

| 进度 | 阶段 |
| --- | --- |
| 0–5% | 来源识别和页面解析 |
| 5–15% | 下载和媒体验证 |
| 15–20% | 标准化和切片 |
| 20–90% | 按已完成音频时长计算转写进度 |
| 90–97% | 合并、边界去重和格式化 |
| 97–100% | 上传产物和提交结果 |

转写进度按已完成片段的音频时长计算，比按片段数量更准确。

## 10. 中文播客基准测试

在确定生产默认 Provider 前，建立一个可重复的小型评测集：

- 至少选择三期取得合法测试权限的中文播客。
- 每期截取约 10 分钟，覆盖单人叙述、双人访谈和多人讨论。
- 样本包含中英文混说、专有名词、口语停顿、音乐或广告、重叠讲话和不同音质。
- 人工制作带时间范围的参考文字稿；若评测说话人分离，再增加参考说话人标签。

指标：

| 指标 | 目的 |
| --- | --- |
| CER | 衡量中文字符级识别错误 |
| 专有名词准确率 | 衡量人名、公司名、产品名和英文词 |
| 时间戳误差 | 衡量字幕与跳转可用性 |
| DER | 启用说话人分离时衡量说话人错误 |
| 实时倍率 | 处理耗时 / 音频时长 |
| 峰值 CPU、GPU、内存和临时磁盘 | 评估 Worker 规格 |
| 每音频小时费用 | 比较云服务和自托管成本 |
| 失败重试额外费用 | 衡量恢复设计和供应商幂等能力 |

评测必须固定音频摘要、Provider/模型版本、参数、运行区域和日期，避免不同版本结果混用。原始样本不得提交到公开仓库。

## 11. 实施顺序

### P0：来源和媒体链路

- 建立 `podcast-tools` Worker 包和任务 manifest。
- 实现 `XiaoyuzhouSourceAdapter` 及固定 HTML fixture 测试。
- 实现安全流式下载、SHA-256、`ffprobe` 和工作目录清理。
- 只验证来源检查点、进度和失败错误，不调用真实转写服务。

### P1：首个端到端 Provider

- 定义 Provider 能力契约和规范化结果模型。
- 接入 ElevenLabs Scribe v2。
- 实现标准化、VAD/静音边界切片、逐片检查点和合并去重。
- 生成一份 Markdown 产物并完成 CLI 提交、观察和下载闭环。

### P2：质量和恢复验证

- 建立中文播客评测集，对比 ElevenLabs、Deepgram、FunASR 和 faster-whisper。
- 验证 Worker 被终止、租约过期和第三方超时后的恢复行为。
- 验证来源页面变化、音频摘要变化、重复请求和产物大小限制。
- 根据结果确定生产默认 Provider、质量档位映射和资源规格。

### P3：说话人和更多来源

- 选择全局说话人分离路线，再开放 `speaker_diarization=true`。
- 增加通用 RSS enclosure 和其他公开播客平台适配器。
- 根据平台多产物能力增加 SRT/VTT 和词级 JSON。

## 12. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 小宇宙页面结构变化 | 专用 Adapter、fixture、明确解析错误、通用 RSS/HTML 回退和独立 Worker 发版 |
| CDN 地址失效或内容变化 | 恢复时重新解析，下载后比较 SHA-256、时长和来源快照 |
| SSRF 或危险重定向 | host allowlist、逐跳 DNS/IP 校验、限制 scheme 和重定向次数 |
| 长音频耗尽内存或磁盘 | 流式下载、大小/时长限制、受控工作目录和完成后清理 |
| 固定切片破坏语义 | VAD/静音边界、短重叠、基于时间和文本的边界去重 |
| 第三方限流或重复计费 | 有界并发、退避、稳定请求键、请求 ID 检查点和错误分类 |
| 中文准确率不可接受 | 建立 CER 基准，对比 FunASR、faster-whisper 和多家云服务 |
| 分片说话人标签错配 | V1 关闭；后续使用全局 diarization 或跨片段聚类 |
| 第三方数据隐私问题 | 明确区域和保留策略，允许切换自托管 Provider，不记录敏感 URL |
| 模型或 API 行为漂移 | 固定 Provider/模型版本并记录到检查点和任务 release digest |

## 13. 待实现验证项

- 小宇宙不同年份、不同音频格式和分享跳转链接的 fixture 覆盖范围。
- CDN 下载是否在部分节目中要求 Referer、User-Agent 或临时签名。
- ElevenLabs 单次提交和内部切片行为是否满足玉虚的片段级恢复与成本控制要求。
- Provider 是否提供真正幂等请求、异步结果查询和取消能力。
- VAD 切片参数及重叠去重算法对中文标点和专有名词的影响。
- 当前 5 MiB 单文本产物是否足以覆盖允许的最大播客时长。
- 音频临时资源在 Worker 重启或换实例后的保存位置与清理策略。

这些验证项不改变“客户端只提交链接、领域处理在服务端 Worker”的架构边界。

## 14. 参考资料

- [Podforge](https://github.com/dairui1/podforge)
- [Podforge Xiaoyuzhou adapter](https://github.com/dairui1/podforge/blob/main/src/sources/xiaoyuzhou.ts)
- [Podforge generic source adapter](https://github.com/dairui1/podforge/blob/main/src/sources/generic.ts)
- [Podforge transcription workflow](https://github.com/dairui1/podforge/blob/main/src/transcribe/workflow.ts)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [WhisperX](https://github.com/m-bain/whisperX)
- [pyannote.audio](https://github.com/pyannote/pyannote-audio)
- [FunASR](https://github.com/modelscope/FunASR)
- [SenseVoice](https://github.com/QwenAudio/SenseVoice)
- [ElevenLabs Speech to Text](https://elevenlabs.io/docs/capabilities/speech-to-text)
- [Deepgram Models and Languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Deepgram Speaker Diarization](https://developers.deepgram.com/docs/diarization)
- [OpenAI Speech to text](https://platform.openai.com/docs/guides/speech-to-text)
- [AssemblyAI Speaker Diarization](https://www.assemblyai.com/docs/speech-to-text/speaker-diarization)
