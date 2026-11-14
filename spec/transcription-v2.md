# 本地说话者转写 v2

日期：2026-11-11。状态：用户已批准方案，P1–P6 代码及自动验证已完成；P0 真实模型质量与性能验收待完成。用户已选择 Whisper + 本地独立说话者模型，并确认：新任务只保存 v2，已有稿件保留为 v1。详细开发方案见 [transcription-v2-development-plan.md](transcription-v2-development-plan.md)，实施证据见 [进度记录](../taskbase/tasks/transcription-v2-progress.md)，安装见 [操作文档](../taskbase/docs/transcription-v2.md)。

## 目标与范围

播客转写在同一整集内区分说话者；Web 阅读、服务端 JSON 和 Markdown 导出显示一致编号。说话者编号不代表姓名，不做声纹身份识别。保留 Web 队列 / Runner 决定入库的规则。

- 新任务默认 `version: 2`；v2 必须完成说话者分离，缺依赖/权重/授权或分析失败时任务失败，不降级并伪装成 v2。
- 产品新建任务只生成 v2；不增加创建新 v1 的产品入口。旧平台输出缺版本视为 v1。既有数据库记录迁移为 v1，ID、内容、任务与产物关联不变；不重复生成 v1。
- 同单集可以有不同任务的 v1/v2。默认阅读优先 v2，再回退 v1；可指定版本阅读旧稿。列表与下载明确版本。
- 不批量重跑旧稿。仅有 v1 的单集可主动生成 v2；新建 v2 队列只按已有 v2 去重。不能复用另一个任务的旧 ASR 结果当作 v2，避免缺词时间或音源变化。

## 技术方案与边界

选择 `pyannote.audio` 4.x 的 `pyannote/speaker-diarization-community-1`。Python 桥接程序仅接受此本地推理模型或本地模型目录，关闭遥测；禁止替换成云端 precision 模型。初次权重下载需要网络和 Hugging Face 授权，已缓存模型可离线使用。

ffmpeg 生成整集 16 kHz 单声道 WAV → 整集 pyannote → Whisper 按现有 600 秒切片转写（v2 开启 word timestamps）→ 合并为绝对时间 → 按词与说话者区间的交叠对齐 → 生成带 speaker_id 的片段。全局标签按首次出现映射为 speaker_1、speaker_2；不对每个切片重新编号。不按字符比例拆分文本。

CPU首测后用户批准增加可选MLX/MPS加速：默认CLI/CPU保持不变，显式配置MLX时使用项目内桥接和专用Python，必须保留词时间戳及简体词文本；全部缺失词时间戳时明确失败。检查点区分后端，基准记录实际设备，自检遵循所选后端。设备不支持时不静默回退，单人/短样本的性能测试不能代替自然多人及1小时整集验收。

对齐优先使用词时间；缺词数据时保留原片段并按交叠分配。无交叠或多人交叠且不能确定主导者时不猜测，显示“说话者未确定”。重复/重叠区间先按同一说话者并集计算，避免重复计权。不会分离重叠语音为多条音轨。词重组必须保持原识别文本；词文本无法还原原片段时回退整段对齐。

检查点含音频摘要、分块配置、语言、ASR 配置、词时间选项；说话者检查点另含模型/设备/人数配置。旧检查点或配置改变不复用错误数据。心跳失效、退出和超时必须中止 Python 进程组，并清理临时音频。

## 数据契约

`TranscriptSegment = { start, end, text, speaker_id?: string }`。
记录新增 `version: 1 | 2`、`diarization: { provider, model, ...非秘密运行信息 } | null`；使用幂等增量列迁移，不重建旧表。`task_id` 仍唯一，新任务只保存一份 v2。
所有新提交入口显式写 `version: 2`，新版 Worker 对缺版本输入也默认生成 v2。旧输出缺 version 视为 v1。明确请求 v2 却收到 v1，或 v2 元数据/片段无效，属于确定性契约错误：Runner 将队列项标为 failed、清除 phase、保留 task_id 并暂停队列，不反复补偿同一错误结果。v2 必须包含成功的说话者分析元数据及至少一个有效标签。
旧 submission_json / 幂等键不重写，历史已完成结果继续兼容 v1。task_id 已存在时版本不可更改；生成 v2 必须新建任务。
API 路径中的 `/api/v1` 是 API 版本，与稿件的 v1/v2 无关；稿件列表可用 `version=1|2` 筛选，单集阅读可用同名参数选择版本。

## 项目结构与命令

从 `taskbase/` 执行；TypeScript 由 Node 24 直接运行，不引入旧 apps/packages。

- `src/transcription/diarization.ts`：本地模型适配器、区间校验、说话者对齐。
- `scripts/diarize.py`：Python 推理与依赖检查；`scripts/requirements-diarization.txt`：Python 依赖。
- `src/transcription/{asr,worker,store,runner,manifest,markdown}.ts`：接入与版本契约。
- `web/server.ts`、`web/public/{app.js,styles.css}`：API、阅读和样式。
- `test/transcription-*.test.ts`：Node test；Python unittest 使用替身模型，无外部调用。

命令：`npm run typecheck`；`node --test test/*.test.ts`；`python3 -m unittest discover -s test -p '*_test.py'`；`node scripts/smoke-web.ts`。

## 代码风格

沿用严格 TypeScript、具名导出、单引号和现有 runProcess：

```ts
const version = task.version ?? 2;
if (version === 2 && !diarizer) throw new Error('v2 转写需要本地说话者模型');
```

## 验收与验证边界

1. 旧库升级重复执行安全，v1 原稿与 ID 不变；v2 单任务幂等、同集默认选 v2、版本过滤正确。
2. 两人交替、单人、重叠、静音、中文/英文词重组、跨 600 秒分块及旧检查点均覆盖。
3. 模型桥接以本地假 pipeline 验证参数与 JSON；缺模型依赖错误明确，密钥不进入命令行或日志。
4. Worker 到 Runner 到服务端 API / Markdown / Chrome 阅读页以双人替身结果验证。
5. 全套测试、类型检查、前端语法及真实浏览器检查通过。替身测试不能代表真实音频识别准确率；真实模型验收须单独记录，依赖授权不能伪造。

始终保留用户未提交改动；不提交密钥、不自动接受第三方条款、不改变生产数据或重启正在处理任务的后台服务。Python 依赖隔离在专用虚拟环境，避免改坏现有 Whisper。

## 官方依据

- https://github.com/pyannote/pyannote-audio （2026-11-11 核对 README：本地 community-1、token 参数、speaker_diarization 输出、遥测开关）
- https://huggingface.co/pyannote/speaker-diarization-community-1 （用户需接受模型条款）
