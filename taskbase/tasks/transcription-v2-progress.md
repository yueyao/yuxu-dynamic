# 转写 v2 实施记录

方案：../../spec/transcription-v2-development-plan.md；用户于2026-11-11明确批准开发。保留原修复计划及用户其他未提交内容；新工作在feat/transcription-v2分支，不自动提交/部署。

Ruling: P0真实推理缺用户模型授权/音频，不能替用户接受条款；先实现可独立验证的存储、桥接、算法与完整流程，并准备基准工具；真实准确率/耗时维持未验收，生产启用受此门槛约束。

- [ ] P0 依赖与本机基准（授权/权重加载及510秒真实样本首测完成；速度未达预期，多人质量/整集验收未完成）
- [x] P1 旧库迁移、版本存储与校验（含四进程并发迁移）
- [x] P2 本地模型桥接与说话者对齐（替身验证；真实模型质量归P0）
- [x] P3 Whisper词时间与分块合并（跨600秒及中英文空白）
- [x] P4 Worker/Runner契约和恢复（单v2产物、指纹恢复、错误停止补偿）
- [x] P5 API/CLI/队列版本逻辑（v1升级、v2去重、历史准确记录）
- [x] P6 页面/复制/导出/文档（Chrome检查通过）
- [x] 全量自动验证与独立代码审查（真实质量/性能仍归P0）
- [x] 用户批准后的MLX/MPS加速扩展、独立审查修复和510秒真实样本复测（未切换后台配置）

## 2026-11-11 验证证据

- Node24.19.0：`node --test test/*.test.ts`，85/85通过，无跳过；完整日志 `/private/tmp/yuxun-v2-final-tests.log`。HTTP测试使用临时本机服务和数据库，模型均为替身。
- `node node_modules/typescript/bin/tsc --noEmit`、`node --check web/public/app.js`均退出0。
- `python3 -m unittest discover -s test -p '*_test.py'`，4/4通过。
- `node scripts/smoke-web.ts`：Chrome登录、分页、v1/v2切换、双人阅读、安全文本及带标签复制通过。
- 依赖安装在 `/private/tmp/yuxun-diarization-venv` 隔离尝试，最初遇DNS/TLS错误；用户要求继续后，官方PyPI重试成功，仍未降低TLS验证。未改全局Whisper、未修改生产库或后台服务。
- 实际环境为Python3.13.12、pyannote.audio4.0.7、torch2.15.0、torchaudio2.11.1、torchcodec0.17.0。桥接`--check`退出0；`pip check`无冲突；pyannote真实音频读取器解码合成WAV得到16000Hz、shape[1,16000]。这仅证明依赖导入和解码，不代表加载权重/推理通过。
- `--resolve-only --offline`在未缓存模型时退出1并返回`DIARIZATION_FAILED (LocalEntryNotFoundError)`，符合预期。未检测到当前进程HF_TOKEN、本地HF token文件或community-1缓存。依赖冻结记录 `/private/tmp/yuxun-diarization-packages.txt`，安装日志 `/private/tmp/yuxun-diarization-install-retry.log`。

## 用户授权后的模型检查

- 用户明确告知“已授权”，已检测到本地Hugging Face凭据；不读取或输出Token值。使用既有本机凭据下载community-1，无新增条款代签。
- 桥接`--prepare`退出0，`model_loaded:true`；随后固定revision再次执行`--prepare --offline`，退出0。revision为`3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`，缓存10个文件约33.7MB。在线/离线加载日志分别为`/private/tmp/yuxun-community1-prepare.log`、`/private/tmp/yuxun-community1-offline-prepare.log`。加载输出明确保留`inference_verified:false`，不误报为质量验收。
- 发现本机在用Worker指定`mlx-whisper-compat`；该脚本忽略`--word_timestamps`，不能作为词级对齐已验收配置。标准Whisper基准显式使用`/Library/Frameworks/Python.framework/Versions/3.13/bin/whisper`；未修改在用配置、全局CLI或后台服务。
- 离线真实模型冒烟：用macOS本机Tingting/Eddy合成46.819秒音频，按A/B/A/B排列。pyannote自动识别2个说话者，前两次交接约11.877秒、23.386秒，再次交接35.283秒；同一声音重复出现保持编号。结果`/private/tmp/yuxun-community1-smoke-2cmd25vq/diarization.json`。最初沙箱内`say`返回空文件，转为获准的本机合成后验证音频非空再推理；空样本失败不当作模型缺陷。
- 标准Whisper small/CPU + community-1离线完整基准工具退出0并生成v2 Markdown；单次46.819秒合成样本：原版ASR15.740秒、词时间ASR11.119秒、模型解析准备3.380秒、说话者分析（含加载）22.561秒、v2各阶段之和37.168秒。两次ASR受热缓存/系统负载影响，不据此断言词时间更快；未采峰值RSS，未跑三次，不外推1小时耗时。报告`/private/tmp/yuxun-community1-smoke-2cmd25vq/benchmark.json`及`.md`。
- 合成样本的pyannote区分双人成功，但Whisper漏转第二个声音，最终Markdown仅保留了说话者1的内容。此样本只证明真实依赖/权重/对齐/导出链路可执行，不作为整体质量通过依据。用户真实样本仍待提供，P0保持未完成。

## 独立审查与修复

独立审查完成，报告2项Important，无Critical。核对官方4.0.7 wheel中`from_pretrained`、本地config及`$model`路径展开契约，无已知API不兼容结论。

Final: fixed 普通v1升级误置force、绕过Runner二次去重 — `v1升级排队后已有v2时二次去重，不强制重复转写` RED→GREEN，suite85/85。

Final: fixed 升级沿用旧音源/标题/节目 — `已完成v1升级使用当前音源和元数据，保留在途输入` RED→GREEN，suite85/85；新幂等键重建时更新元数据，在途快照不变。

补充修复：重新配对会覆盖自定义环境，导致丢失v2 Python路径、离线配置及HF凭据。扩展`Mac pair`回归先失败再通过；只替换配对管理字段，保留其余配置，suite85/85。

## 用户真实音频首测

- 用户提供`/Users/dynamic/Downloads/tiancai-510.m4a`，probe确认510秒AAC双声道，转码510.02775秒。固定标准Whisper small/CPU和community-1/CPU、离线缓存revision，不修改在用配置。
- `scripts/benchmark-transcription.ts --run-once`外包macOS`/usr/bin/time -l`，退出0。原版ASR235.001秒、词时间ASR568.546秒、模型解析14.909秒、说话者分析1058.484秒、对齐0.027秒，v2阶段之和1642.646秒（27分23秒）。峰值RSS约2.39GiB。完整测试含原版对照共31分18秒。
- 生成182段v2稿、154段主标签“说话者1”、28段未知，约2387字符，最后片段至08:30；未有人工说话者参考标注，不能认定人数/准确率达标，稿中有疑似同音识别错误。
- 首测结束后系统交换用量约6.84GB，无开始基线，因此不把慢归因于交换。说话者分析占v2耗时约64%，先定位再决定优化/复测；不在这次明显未达速度目标的条件下直接累积三轮测量并宣称已完成P0。
- 详情见`../docs/transcription-v2-benchmark-20261111.md`，本机稿件`/private/tmp/yuxun-tiancai-510-r_3z0c3t/run1.json.md`、报告`run1.json`、资源报告`run1.memory.txt`。自然多人标注及1小时整集仍待验收，不将短样本线性外推当作一小时实测。
- 为定位开销，对原文件前60秒使用同pipeline的官方hook测量，保持默认参数，退出0；加载14.83秒、切分6.83秒、声纹提取113.34秒、聚类输出约0.1秒，纯推理120.51秒。主要慢点为CPU声纹提取；测量数据`profile60.json`/`profile60.log`。只做定位，没有更改产品代码、设备或生产配置。

## 交付边界

安装、自检、离线准备、基准命令见 `../docs/transcription-v2.md`。授权、权重下载及离线加载已完成；尚缺双人/三人自然对话标注音频和整集1小时性能报告；不推测本机速度，不以合成测试代替质量验收。正式启用还需持久Python环境与可输出词时间戳的Whisper配置。保留分支及工作区，未提交、推送或部署。

## 2026-11-11 至 12 日：用户批准后的加速扩展

用户批准继续按优化方案执行。已新增显式`TRANSCRIPTION_WHISPER_BACKEND=mlx`、独立`TRANSCRIPTION_MLX_PYTHON`和项目内桥接；默认CLI/CPU保持不变。模型支持真实词时间戳，缺失时报错，不继续将旧兼容脚本当作有效词对齐配置；MLX与CLI检查点身份隔离。`doctor`在MLX模式验证所选Python依赖，不要求标准Whisper CLI。没有覆盖用户旧全局兼容脚本或修改在用环境、后台服务。

- 60秒真实样本CPU/MPS对照：纯推理26.429/8.862秒、含导入加载29.739/13.104秒；两轮13个区间和标签完全相同，均1人。同轮纯推理约2.98倍；旧CPU120.506秒不能全归入设备差异。
- MLX真实60秒冒烟：25段、271词，含正时长词时间戳，至59.98秒。
- 完整510秒样本三次离线加速计时：v2阶段之和381.562、142.328、130.332秒，中位数142.328秒，范围130.332–381.562秒。跨两天且负载未受控，保留所有值；不宣称由此完成一小时性能门槛。
- 基准设备报告原把MLX写成CPU。新增CLI/MLX双后端回归，MLX分支先断言失败（`cpu !== mlx`），修正报告后双分支通过。
- MLX自检及doctor后端回归均先失败再修复；真实MLX `--check`通过，明确只标记依赖可导入。
- Final: fixed 独立审查发现逐词OpenCC会将“乾隆”写成“干隆”并覆盖片段正文 — `test_context_conversion_preserves_segment_instead_of_joined_words`两个上下文用例RED→GREEN；保留整段转换，词重建不一致时用既有整段对齐，不编造时间边界；真实OpenCC额外复核通过。代价是受上下文影响的少量片段不再按词拆说话者，优先保留正确正文。
- 文本修正后第4次完整真实基准退出0：词时间ASR29.883秒、解析6.152秒、MPS分析58.400秒、v2阶段之和95.172秒；额外原版ASR24.944秒不计入v2。总基准墙钟120.43秒，RSS1,386,315,776字节（1.29GiB）。本轮与替身回归部分重合，不称为受控空闲基准。220段中198段主标签、22段未知，未标注自然多人参考，P0仍未完整验收。
- 最终自动验证：Node24.19.0全量`node --test test/*.test.ts` **89/89**，无跳过；Python `python3 -m unittest discover -s test -p '*_test.py'` **8/8**；TypeScript `tsc --noEmit`、`node --check web/public/app.js`、`git diff --check`退出0。全量HTTP和资源统计测试获准使用本机回环及`/usr/bin/time`，仅临时数据库和替身模型；未访问生产。
- 原始四次报告、RSS、最终稿和Node日志已复制到Git忽略目录`.data/benchmarks/transcription-v2-20261112/`，最终稿`tiancai-510-v2.md`；无音频入Git或上传。耗时和限制同步到`docs/transcription-v2-benchmark-20261111.md`与操作文档。未提交、推送、安装全局CLI、持久化pyannote环境或切换后台Worker。
