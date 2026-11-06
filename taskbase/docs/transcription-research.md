# 音频转写能力调研

调研时间：2026-11-06  
目标：为 Taskbase 的播客链路增加「音频 → 文字」，后续再接「文字 → 文章 / Markdown」。

> 落地状态（2026-11-06）：新 taskbase 已实现 **Whisper CLI 本地 Provider** 与 `transcription-tools` Worker；FunASR/MLX/云端仍可作为后续替换。本文保留选型对比。

## 1. 结论先行

按当前“单用户、单服务器、播客回填、中文为主、批量非实时”的场景，建议：

1. **优先验证本地方案**：FunASR + SenseVoiceSmall / Fun-ASR-Nano + FSMN-VAD + 标点，必要时加 CAM++ 说话人分离。
   - 优点：无按分钟费用、音频不出服务器、可批量、CPU/GPU 都能跑。
   - 风险：需要自己维护 Python 运行时和模型；英文/专业术语质量需要用自己的节目试听。
2. **如果不想维护模型，选腾讯云录音文件识别（大模型 2.0）作为云端兜底**：
   - 官方计费页显示预付费 60 小时 48 元起，约 **0.8 元/小时**；每月 10 小时免费额度（2026-10-29 更新）。
   - 适合先跑通业务，再决定是否迁回本地。
3. **Whisper / faster-whisper 作为高精度备选**，不建议作为第一版唯一引擎：
   - 英文和混合语言通常更稳，但中文标点、长音频幻觉、说话人分离要额外处理。
   - 有 NVIDIA GPU 时，faster-whisper large-v3 的吞吐很好；纯 CPU 上 large 型号会明显变慢。

**建议下一阶段不要直接写死某个供应商**，先实现 provider 接口（local/tencent/openai-compatible），用 5–10 期真实节目做 A/B 试听，再决定默认引擎。

## 2. 需求假设

- 音频：播客单集，约 20–120 分钟；中文为主，可能有中英混合、人名和专有名词。
- 模式：批量离线转写，不要求实时字幕。
- 输出：带时间戳的段落文本；可选说话人标签；最终要能生成 Markdown/文章。
- 部署：单用户、单服务器；可能是 Mac（Apple Silicon）或 Linux；GPU 情况未知。
- 隐私：播客内容不希望无条件上传第三方；本地优先。
- 平台约束：任务执行超时当前最大 6 小时；产物默认上限 5 MiB（纯文本足够）。
- 目前没有音频存储需求：默认“下载到临时目录 → 转写 → 删除音频”，只保留文本；音频是否保留做成配置。

## 3. 候选方案对比

| 方案 | 形态 | 中文 | 英文/混合 | 时间戳 | 说话人 | 标点 | 成本 | 隐私 | 运维 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FunASR + SenseVoiceSmall | 本地 Python | 强（官方称中文/粤语有优势） | 支持 zh/en/ja/ko/yue | 有 | 需组合 CAM++ | 需组合 ct-punc / ITN | 硬件+电费 | 本地 | 中 |
| FunASR + Fun-ASR-Nano | 本地 Python / vLLM | 强（含方言口音） | 800M，支持 zh/en/ja、31 语种 MLT 版本 | 取决于模型/路径 | 可组合 | 好 | 硬件+电费 | 本地 | 中 |
| faster-whisper large-v3 / turbo | 本地 CTranslate2 | 好 | 强 | 词级 | 需 WhisperX/pyannote | 一般到好 | 硬件+电费 | 本地 | 中 |
| whisper.cpp | 本地 C/C++ | 好 | 强 | 有 | 需另配 | 一般 | 硬件+电费 | 本地 | 低 |
| 腾讯云录音文件识别（大模型 2.0） | 云 API | 强 | 好 | 有 | 产品含角色分离/说话人相关能力，需按子产品核对 | 有 | 约 0.8 元/小时（预付费） | 音频出服务器 | 低 |
| 阿里云百炼 Fun-ASR / Qwen-ASR | 云 API | 强（方言覆盖广） | 好 | 有 | 文件转写支持说话人分离 | 有 | 按模型价格页 | 音频出服务器 | 低 |
| OpenAI Whisper / gpt-4o-transcribe | 云 API | 可用 | 强 | 有 | 部分型号支持 diarization，需按官方文档 | 好 | 按分钟计费，实施前核对 | 音频出境 | 低 |

> 质量结论不能只看参数和宣传：必须用你自己的 5–10 期节目、包含人名/中英混说/背景音乐的片段做试听和人工错误统计。

## 4. 关键证据

### 4.1 faster-whisper

官方 README 给出的 13 分钟音频基准（RTX 3070 Ti 8GB / i7-12700K）：

- large-v2，GPU fp16：1 分 03 秒，显存 4.5GB；int8：59 秒，约 2.9GB。
- large-v2，GPU int8 + batch_size=8：16 秒，约 4.5GB。
- small，CPU int8：1 分 42 秒，约 1.5GB。

按 README 的量级线性外推（仅用于估算，不是承诺）：

- 1 小时音频，GPU large-v3 约 5 分钟级；批处理更快。
- 1 小时音频，CPU small 约 8 分钟级；CPU large 会明显慢于 GPU。
- 支持 word timestamps、VAD；VAD 可减少静音段幻觉。
- 说话人分离不是内置能力，需要 WhisperX/pyannote 等额外组件。

来源：[SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)

### 4.2 FunASR / SenseVoice / Fun-ASR

FunASR 官方仓库当前提供：

- 文件转写、VAD、标点、说话人分离管线；
- SenseVoiceSmall（234M，zh/en/ja/ko/yue，情感/音频事件）；
- Fun-ASR-Nano（800M，zh/en/ja + 方言口音；另有 31 语种 MLT 版本）；
- Paraformer-zh（220M，中文/英文，带时间戳）；
- FSMN-VAD、CAM++ 说话人嵌入、ct-punc 标点；
- OpenAI-compatible HTTP / MCP / vLLM / llama.cpp 等部署路径。

SenseVoice 官方 README 的定位：

- 非自回归端到端，官方称同等参数下比 Whisper-Small 快 5 倍以上、比 Whisper-Large 快 15 倍以上（项目自述，需实测）。
- 中文/粤语识别在官方对比中有优势。
- 时间戳通过 FunASR 的 `sentence_info` 输出；说话人分离是“SenseVoiceSmall + FSMN-VAD + CAM++”组合，不是 SenseVoiceSmall 单模型输出。
- 支持长音频分段；1 小时音频不要一次性塞进 encoder。

补充：FunASR 官网的可复现基准记录（2026-09-01 页面）给出：

- SenseVoiceSmall Q8 GGUF，CPU 8 线程、内置 FSMN-VAD：约 **20x realtime**，micro-CER **8.17%**（184 条 44–60 秒普通话片段；CPU 型号和完整软件栈未记录）。
- Paraformer Q8 GGUF，CPU 8 线程：约 **21x realtime**，micro-CER **9.89%**（同一批片段）。
- Fun-ASR-Nano 在 RTX 4090 上：中文 c=1 约 14.36 samples/s，c=16 约 127.25 samples/s；SeedTTS 中文 CER 1.64%（干净 TTS，不是播客真实音频）。
- H100 上的 TensorRT/Triton SenseVoice 记录主要是兼容性与一致性验证，不是吞吐承诺。

“20x realtime”是官方记录中的量级，不是我们的生产承诺；按它粗算 1 小时音频约 3 分钟、100 小时约 5 小时 CPU 时间，但实际会受音频长度、VAD、并发、CPU 型号影响。上线前必须用自己的 20–50 条节目复测。

FunASR 工具包本身是 **MIT License**；SenseVoice、Paraformer、Fun-ASR 等模型权重可能有各自的模型许可，商用/再分发前要单独核对模型卡。

来源：

- [modelscope/FunASR](https://github.com/modelscope/FunASR)
- [FunASR LICENSE（MIT）](https://github.com/modelscope/FunASR/blob/main/LICENSE)
- [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice)
- [FunASR 官网](https://www.funasr.com/en/)
- [FunASR 可复现基准](https://www.funasr.com/en/benchmarks.html)
- [FunASR 模型选择指南](https://www.funasr.com/en/docs/model-selection.html)

### 4.3 腾讯云

腾讯云语音识别计费页（2026-10-29 更新）显示：

- 录音文件识别（大模型 2.0）：预付费 60 小时 48 元，约 0.8 元/小时；1,000 小时 780 元。
- 每月免费额度：录音文件识别 10 小时。
- 计费按秒，最低 1 秒；预付费包 1 年有效。
- 产品框架中还列出情绪识别、分段、角色分离等增值项，具体是否包含在所选子产品需要按接口文档核对。

粗算：

- 100 期 × 1 小时 = 100 小时；按 0.8 元/小时约 80 元。
- 每月 10 小时免费额度，适合先验证 5–10 期。
- 1,000 小时回填约 780 元（不含增值项）。

来源：[腾讯云语音识别计费概述（在线版）](https://cloud.tencent.com/document/product/1093/35686)

### 4.4 阿里云百炼

官方语音识别选型页显示：

- 非实时文件转写：`qwen-audio-3.1-asr-flash-filetrans`、`fun-asr`，最大 12 小时 / 2GB，支持说话人分离（文件转写）。
- `qwen-audio-3.1-asr-flash` 适合 5 分钟以内短音频。
- `fun-asr-flash-2026-06-15` 也是 5 分钟以内。
- 支持热词、Prompt 上下文、方言/多语种、说话人分离。
- 价格以百炼模型价格页为准，且模型迭代快，实施前需重新核对。

来源：

- [阿里云百炼语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model)
- [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)

### 4.5 OpenAI（仅对照）

OpenAI 的 Whisper / gpt-4o-transcribe 系列适合英文和混合语言，按分钟计费；官方定价页和文档从当前网络访问受限，本文不写具体单价。若考虑使用，实施前需用官方账号确认：

- 当前模型名与价格；
- 文件大小/时长限制；
- 是否支持 diarization；
- 数据出境与合规。

## 5. 与本平台的结合设计

不要把转写塞进现有 podcast worker 的“列表采集”任务里。建议新增独立应用：

```text
app_id: transcription-tools
tasks:
  episode/transcribe   输入 { episode_id, engine?, language? }
  episode/export       可选：把转写稿整理成 Markdown
```

执行链路（单个任务内部完成，不做跨任务编排）：

```text
读取 episode 元数据
  → 下载音频到临时目录（或直接给云端 URL）
  → 必要时 ffmpeg 转 16k mono / 切片
  → 调本地 ASR HTTP 或云 API
  → 合并 segments / 时间戳 / 说话人
  → 写 podcast_transcripts
  → 生成 Markdown / JSON 产物
  → 删除临时音频（默认）
```

应用表建议：

```text
podcast_transcripts
  id, episode_id, provider, model, language,
  duration_seconds, text, segments_json,
  status, error, created_at, updated_at

podcast_transcription_runs
  id, task_id, episode_id, provider, engine,
  started_at, finished_at, status, error
```

平台侧：

- 任务 `execution_timeout_ms` 设 2–6 小时；
- app `max_concurrency: 1`，避免本机 CPU/GPU 抢占；
- 每 20–30 分钟或每个 API 限制切片，`task_steps` 记录 chunk 结果；恢复时跳过已完成 chunk；
- 进度按 chunk 百分比上报；
- 产物：`.md` + `.json`（segments）；音频不进产物；
- 云 API key 只放 worker 环境变量，绝不进 Web/数据库/日志；
- 默认音频保留 0 天；如需回听，单独配置临时目录和清理任务。

## 6. 成本与吞吐估算

### 云端（腾讯云示例）

| 音频量 | 约费用（0.8 元/小时） | 说明 |
| --- | --- | --- |
| 10 小时/月 | 0 元 | 免费额度内 |
| 100 小时 | 约 80 元 | 适合一次性回填 |
| 1,000 小时 | 约 780 元 | 预付费 1,000 小时包 |

### 本地

- 软件成本 0；成本在硬件、电力和维护。
- 有 NVIDIA GPU：faster-whisper / Fun-ASR-Nano 吞吐好，适合批量。
- 纯 CPU：SenseVoiceSmall / whisper.cpp 可跑，但 100 小时回填可能需要数天，需实测。
- Apple Silicon：可评估 MLX Whisper / whisper.cpp；FunASR 在 macOS 上的 GPU 支持需要单独验证。

## 7. 推荐路径

### Phase 0：试听选型（建议先做，1–2 天）

选 5–10 期代表性节目（中文、英文、中英混说、有人名/术语、有背景音乐），分别用：

- 本地 FunASR SenseVoiceSmall + FSMN-VAD + ct-punc；
- 腾讯云录音文件识别大模型 2.0（免费额度）；
- 可选 faster-whisper large-v3（如有 GPU）。

统计：人工抽听错误、人名/术语、标点、时间戳、说话人、长音频稳定性。**不要只看 CER 一个指标。**

### Phase 1：Provider 接口 + 云端兜底

- 定义 `AsrProvider` 接口：`transcribe(audio, options) -> segments`。
- 先接腾讯云（低运维、免费额度）验证平台任务链路、UI、产物。
- 同时保留本地 provider 骨架，后续接 FunASR。

### Phase 2：本地引擎

- 部署 FunASR OpenAI-compatible HTTP 服务（`/v1/audio/transcriptions`）。
- worker 只通过 HTTP 调本地服务，不把 Python 依赖塞进 Node 平台进程。
- 如果中文质量或说话人不够，再评估 faster-whisper / WhisperX 作为第二引擎。

## 8. 待确认

1. 服务器硬件：Apple Silicon / Linux + NVIDIA GPU / 纯 CPU？
2. 节目语言：纯中文、英文，还是中英混说为主？
3. 是否必须做说话人分离（谁说了什么）？
4. 是否允许把音频上传到腾讯云/阿里云/OpenAI？还是必须全本地？
5. 期望回填量：多少节目、多少小时？
6. 产物要求：逐字稿、可读文章、Markdown、字幕（SRT/VTT）？
7. 是否需要保留音频文件，还是转写后删除？

## 9. 来源

- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)（访问 2026-11-06）
- [modelscope/FunASR](https://github.com/modelscope/FunASR)（访问 2026-11-06）
- [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（访问 2026-11-06）
- [FunASR 官网](https://www.funasr.com/en/)（访问 2026-11-06）
- [腾讯云语音识别计费概述（在线版）](https://cloud.tencent.com/document/product/1093/35686)（更新 2026-10-29）
- [阿里云百炼语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model)（访问 2026-11-06）
- [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)（访问 2026-11-06）
- [OpenAI Whisper](https://github.com/openai/whisper)（访问 2026-11-06；具体 API 价格以官方为准）
