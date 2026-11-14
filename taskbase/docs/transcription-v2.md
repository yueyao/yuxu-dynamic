# 本地说话者转写 v2

v1 为历史原始转写稿；新任务默认 v2，在本机用 Whisper 转写、pyannote community-1 区分说话者。新任务只保存一份 v2，既有 v1 不覆盖、不自动批量重跑。Web 队列 Runner 决定稿件入库，CLI 提交不直接改变入库规则。

## 安装独立环境

community-1 是免费开放模型，在本机运行；不使用 pyannote 收费云服务。首次下载需要网络、免费的 Hugging Face 账号、模型条款授权和读取 Token。

1. 在 [模型页](https://huggingface.co/pyannote/speaker-diarization-community-1) 接受使用条款，在 Hugging Face 创建能读取该模型的 Token；不要把 Token 写入 Git 或聊天。
2. 在 `taskbase/` 创建独立虚拟环境。建议使用 Python 3.11/3.12；具体兼容以本机安装及检查结果为准。不要在现有 Whisper 的 Python 环境直接升级 PyTorch。

```bash
python3.12 -m venv "$HOME/.local/share/yuxun/diarization-venv"
"$HOME/.local/share/yuxun/diarization-venv/bin/python" -m pip install -r scripts/requirements-diarization.txt
"$HOME/.local/share/yuxun/diarization-venv/bin/python" -m pip freeze > /tmp/yuxun-diarization-packages.txt
```

桥接固定 `pyannote.audio==4.0.7`；pip freeze 记录实际 PyTorch/torchcodec 等版本。仍需要 ffmpeg/ffprobe，以及独立安装的 Whisper CLI。

2026-11-11 在本机 M4 的临时隔离环境中，Python3.13.12、pyannote.audio4.0.7、torch2.15.0、torchaudio2.11.1、torchcodec0.17.0 已通过依赖导入、`pip check` 和16kHz WAV解码检查。用户完成Hugging Face授权后，community-1权重已下载，并通过在线准备和离线加载；revision为`3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`。完整环境记录在 `/private/tmp/yuxun-diarization-packages.txt`；临时环境不作为后台Worker的持久配置。权重加载不代表自然对话识别质量已验收。

3. 在 Worker 配置文件 `~/.config/yuxun/worker.env` 增加以下配置。Python 必须用真实绝对路径，`.env` 文件内不展开 `$HOME` 或 `~`。

```dotenv
TRANSCRIPTION_PROVIDER=whisper
TRANSCRIPTION_DIARIZATION_PYTHON=/Users/你的用户名/.local/share/yuxun/diarization-venv/bin/python
TRANSCRIPTION_DIARIZATION_MODEL=pyannote/speaker-diarization-community-1
TRANSCRIPTION_DIARIZATION_DEVICE=cpu
HF_TOKEN=你的本机读取Token
```

保持配置文件权限600。也可使用 Hugging Face 官方本地登录凭据，避免在环境文件里重复保存 Token。

4. 先准备模型，再验证离线加载。以下命令从环境文件读取配置和凭据，不把 Token 放在命令参数里：

```bash
node --env-file="$HOME/.config/yuxun/worker.env" --input-type=module -e 'import { runProcess } from "./src/process.ts"; const e=process.env; console.log(await runProcess(e.TRANSCRIPTION_DIARIZATION_PYTHON, ["scripts/diarize.py", "--prepare", "--model", e.TRANSCRIPTION_DIARIZATION_MODEL ?? "pyannote/speaker-diarization-community-1", "--revision", e.TRANSCRIPTION_DIARIZATION_REVISION ?? "main", "--device", e.TRANSCRIPTION_DIARIZATION_DEVICE ?? "cpu"], { timeoutMs: 3600000 }));'
node --env-file="$HOME/.config/yuxun/worker.env" --input-type=module -e 'import { runProcess } from "./src/process.ts"; const e=process.env; console.log(await runProcess(e.TRANSCRIPTION_DIARIZATION_PYTHON, ["scripts/diarize.py", "--prepare", "--offline", "--model", e.TRANSCRIPTION_DIARIZATION_MODEL ?? "pyannote/speaker-diarization-community-1", "--revision", e.TRANSCRIPTION_DIARIZATION_REVISION ?? "main", "--device", e.TRANSCRIPTION_DIARIZATION_DEVICE ?? "cpu"], { timeoutMs: 3600000 }));'
```

准备输出包含模型revision和包版本；加载成功不等于真实推理已验收。缓存完整后可在环境文件设置 `TRANSCRIPTION_DIARIZATION_OFFLINE=1`。若有固定revision，设置 `TRANSCRIPTION_DIARIZATION_REVISION=<模型commit>`；不设置时解析 main 的实际commit并绑定检查点。可设置 `TRANSCRIPTION_DIARIZATION_NUM_SPEAKERS=2`，不设置则自动估计人数。

默认保持 CPU，可显式选择已在目标机器验证的 MPS/CUDA。2026-11-11 本机 M4 已通过 MPS 短样本和510秒真实音频推理，但自然多人质量与1小时性能验收仍待完成。v2 要求本地 Whisper；现有 FunASR/ElevenLabs Worker 配置会明确报错，不默默切换提供商。

本机现有`worker.env`另指定了旧的`mlx-whisper-compat`。旧脚本忽略`--word_timestamps`，不能用于v2词级对齐；现在请求词时间戳却完全未返回时，会明确报错`ASR_WORD_TIMESTAMPS_REQUIRED`。标准Whisper CLI仍可使用；Apple Silicon可显式选择以下新增的项目内MLX桥接，不需要覆盖全局兼容脚本。

## Apple Silicon：MLX + MPS 可选加速

`scripts/mlx-whisper.py`调用本地MLX Whisper，传递词时间戳开关，同时将片段及词文本转换为简体。正文始终保留整段上下文转换结果；词拼接因OpenCC上下文差异不能重建正文时，回退整段对齐，不用逐词结果覆盖正文。MLX与标准CLI拥有不同的检查点身份，切换后不会误用另一后端的转写缓存。模型依次执行，避免两套模型同时驻留。

尚无MLX环境时独立安装；不要把这些依赖装进pyannote环境：

```bash
python3.12 -m venv "$HOME/.local/share/yuxun/asr-venv"
"$HOME/.local/share/yuxun/asr-venv/bin/python" -m pip install -r scripts/requirements-mlx.txt
"$HOME/.local/share/yuxun/asr-venv/bin/python" scripts/mlx-whisper.py --check
```

已有相同环境时先执行自检，不需要重装。本机已验证MLX环境为Python3.12.13、mlx-whisper0.4.3、opencc-python-reimplemented0.1.7。MLX使用单独的Whisper权重，pyannote的缓存不能代替它；首次转写前先准备MLX模型缓存，之后可设置`HF_HUB_OFFLINE=1`验证离线运行。`--check`只验证依赖可导入，不下载权重、不转写音频，也不代表推理质量通过。

从`taskbase/`运行本机基准时，可通过进程环境显式选择：

```bash
export TRANSCRIPTION_WHISPER_BACKEND=mlx
export TRANSCRIPTION_MLX_PYTHON="$HOME/.local/share/yuxun/asr-venv/bin/python"
export TRANSCRIPTION_WHISPER_MODEL=small
export TRANSCRIPTION_DIARIZATION_DEVICE=mps
```

同时配置前文的`TRANSCRIPTION_DIARIZATION_PYTHON`和模型revision。`TRANSCRIPTION_WHISPER_BACKEND`默认`cli`，仅支持`cli|mlx`；MLX模式忽略`TRANSCRIPTION_WHISPER_BIN`和CLI设备设置，固定使用Apple GPU。Worker配置文件使用相同变量，但Python必须写真实绝对路径。`doctor`在MLX模式检查指定Python及桥接依赖，不要求标准Whisper CLI存在；离线基准仍是验证模型和词时间戳的必要步骤。配置或设备错误会失败，不会静默降级到CPU或旧版稿件。

此次验证只使用命令的进程环境，未自动修改在用Worker配置或重启服务；正式切换需先更新服务端和Worker到相同版本，再修改环境文件并在Worker空闲时重启。

## 验证本机耗时与质量

使用有权处理的本地音频，从 `taskbase/` 执行；工具不提交平台任务、不写生产数据库、不上传音频：

```bash
node --env-file="$HOME/.config/yuxun/worker.env" scripts/benchmark-transcription.ts \
  --input /绝对路径/双人播客.mp3 \
  --output /tmp/transcription-v2-run1.json
```

依次测量原版 Whisper、词时间 Whisper、整集 pyannote，并输出 JSON、带标签 Markdown；macOS 额外生成 `.memory.txt`，保留 `/usr/bin/time -l` 的峰值 RSS。工具不会覆盖既有报告，每次使用不同输出路径。计时包含模型加载，不包含下载、队列等待和上传；模型首次下载须先通过prepare完成。先跑10分钟，再跑整集1小时；缓存后独立运行三次记录中位数与范围，留意交换和降频。人工核对编号、重叠与未知片段，不能只看进程退出码。

已用46.819秒的macOS合成双人语音验证离线真实模型调用：pyannote自动识别2人并保持重复出现时的编号；标准Whisper small/CPU完整链路生成v2稿。该样本中Whisper漏转了第二个声音，因此整体质量没有通过验收。单次短样本不外推整集速度；尚无自然对话准确率及1小时音频实测结论。公式示例或替身测试均不作为实际速度承诺。1小时≤60分钟及非重叠语音错误/未知时长≤10%是待验证目标，详细证据见[实施记录](../tasks/transcription-v2-progress.md)。

随后用户提供510秒真实音频，首轮标准Whisper small/CPU + community-1/CPU的v2阶段之和为27分23秒，识别出1个主标签，存在未知片段和疑似错字；速度未达预期，多人质量尚未验收。阶段耗时、环境及本机稿件路径见[真实样本首测](transcription-v2-benchmark-20261111.md)。

同一音频随后使用MLX small + community-1/MPS完成三次独立进程加速测试：v2阶段之和381.56、142.33、130.33秒，中位数约2分22秒，范围约2分10秒至6分22秒。结果仍只有1个主标签，不能证明自然多人质量达标；跨两天、机器负载未受控，不能据此承诺1小时音频耗时。原始阶段数据及边界见同一[实测记录](transcription-v2-benchmark-20261111.md)。

修正OpenCC上下文转换后，最终完整验证为95.17秒（约1分35秒），RSS约1.29GiB。此单次值不替代上面的波动记录或多人/整集验收；本机最终稿和四次报告保存在Git忽略目录`.data/benchmarks/transcription-v2-20261112/`。

## 使用与升级

- Web 只有 v1 的单集显示“生成 v2”；用户主动点击后创建新任务并保留 v1。仅有 v1 不会被新队列的 v2 去重挡住。
- 同集存在两版本时默认读 v2，可以切换 v1；历史列表支持版本筛选，每条历史的查看/下载绑定确切 transcript_id。
- v2 按“说话者1/2”及时间戳阅读、复制和导出。不推断真实姓名；无可靠交集或重叠难以判定时显示“说话者未确定”。
- 模型失效不自动降级v1。v2返回无效版本/标签时，Runner将队列项标为failed并暂停；升级/修正Worker后由用户明确重试。临时网络/入库故障继续保留补偿。

上线时先暂停提交并等在途任务结束，备份数据库/产物；更新服务端及任务manifest，再更新CLI和Mac Worker，完整验收一集后恢复。已有冻结 submission_json/幂等键不改写，历史无版本结果仍按v1补偿。

全局 CLI 为复制式安装，需要从 `taskbase/` 运行 `npm run install:global`；环境配置保留。Worker空闲时再运行 `yuxun worker install` 更新后台入口并重启；直接从仓库运行代码则无需全局重装。不要只回滚一半组件。

`yuxun worker doctor`读取环境文件检查独立Python依赖及离线模型文件；默认不下载、不运行真实音频推理。其“可导入/已缓存”不能代替样本验收。

## API 与数据

稿件记录新增 `version:1|2`、`diarization`，片段可带 `speaker_id`。旧表事务中增量加列，原稿ID和产物不变；同task_id版本不可更改。读库新代码应先执行迁移，避免旧版写入逻辑覆盖v2。

列表 `GET /api/v1/transcripts?version=2`、`GET /api/transcription/transcripts?version=1` 支持筛选；`GET /api/podcast/episodes/:id/transcript?version=1`读取指定版本，响应带`available_versions`。内部按确切记录读取可用`GET /api/transcription/transcripts/:id`。非法version返回400，无指定版本稿件返回`transcript:null`。`/api/v1` 是API版本，与稿件v1/v2无关。

源码与验收规则见 [开发方案](../../spec/transcription-v2-development-plan.md)和[规格](../../spec/transcription-v2.md)。
