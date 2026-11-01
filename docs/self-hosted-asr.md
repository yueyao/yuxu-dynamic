# 自托管 FunASR 服务部署与运维

| 项目 | 内容 |
| --- | --- |
| 用途 | 为 `podcast-tools/audio/transcribe` 提供无外部付费 API 依赖的语音转写 |
| 默认模型 | SenseVoiceSmall，FunASR 服务别名 `sensevoice` |
| 默认运行时 | Linux x86_64/aarch64、Python 3.11、CPU |
| 服务协议 | 内网 HTTP multipart，`POST /v1/audio/transcriptions` |
| 最后更新 | 2026-11-01 |

## 1. 架构边界

```text
CLI / Web
  → 玉虚 Platform API
  → Podcast Worker（Node.js）
  → FunASR Service（Python + SenseVoiceSmall）
  → 本机/内网模型权重
```

Platform API 仍只负责任务控制面。Podcast Worker 负责来源解析、安全下载、音频标准化、切片、检查点和产物。FunASR Service 是 `podcast-tools` 执行面内部的模型进程，只负责把已标准化的音频片段转成文字。

这个拆分使 Python/PyTorch 依赖不进入平台 API，也不进入 CLI 或浏览器。替换模型、CPU/GPU 运行时或模型服务实现时，公共任务输入契约不变。

## 2. 当前实现

- `createFunASRProvider` 上传 FLAC/WAV 片段，明确传入 `model=sensevoice` 和 `response_format=verbose_json`。
- 响应中的秒级 `segments`/`words` 被归一化为平台毫秒时间戳。后端只返回文本时，Provider 保留一个粗粒度片段。
- 默认 `TRANSCRIPTION_PROVIDER=funasr`；ElevenLabs 仅作显式启用的可选兼容 Provider。
- Provider 的 `408`/`429`/`5xx` 和网络中断被视为基础设施故障，由任务租约进入恢复；其他 `4xx` 作为不可重试业务/配置错误。
- 检查点保存 `provider` 和 `model`。默认模型身份为 `sensevoice@funasr-1.4.19-cpu`，恢复时拒绝混用不同部署。

## 3. CPU 服务启动

要求目标机已安装 Docker Engine 和 Docker Compose。先验证 Compose 展开结果：

```sh
npm run asr:config
```

构建并启动 CPU 容器：

```sh
npm run asr:up
docker compose -f deploy/funasr/compose.yaml logs -f funasr
```

首次启动需下载 SenseVoiceSmall 及其必要组件，模型缓存保存在 `yuxu-funasr_funasr-model-cache` volume。健康检查只能证明进程和已加载模型可访问，不能代替真实中文音频验收：

```sh
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8000/v1/models
```

默认 Compose 只发布到 `127.0.0.1:8000`。同机 Podcast Worker 无需额外配置：

```sh
npm run podcast-worker
```

如果 Worker 在另一容器或内网主机，将 `FUNASR_BASE_URL` 设为经过授权的内网服务地址。官方 `funasr-server` 不提供鉴权；不得直接暴露到公网。跨主机时应由网关提供 TLS、身份验证、上传大小、超时和限流；`FUNASR_API_TOKEN` 仅用于这种会实际校验 Bearer Token 的网关。

停止容器：

```sh
npm run asr:down
```

`down` 不删除模型 volume。只有确认不再需要缓存时，才应由部署者单独删除 volume。

## 4. Worker 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `TRANSCRIPTION_PROVIDER` | `funasr` | `funasr` 为自托管默认；`elevenlabs` 仅显式兼容用 |
| `FUNASR_BASE_URL` | `http://127.0.0.1:8000` | FunASR 服务根 URL |
| `TRANSCRIPTION_MODEL` | `sensevoice` | 发送给 FunASR 的模型别名 |
| `FUNASR_DEPLOYMENT_ID` | `funasr-1.4.19-cpu` | 进入检查点的部署身份；模型、权重或参数改变时必须更改 |
| `TRANSCRIPTION_REQUEST_TIMEOUT_MS` | `1800000` | 单个切片转写请求超时 |
| `FUNASR_API_TOKEN` | 空 | 只在前置网关实际校验 Bearer Token 时使用 |

如果改用审核后的本地模型快照，需同时完成三件事：

1. 将快照以只读 volume 挂载到容器，并让 `funasr-server --model <local-directory>` 指向该目录。
2. Worker 的 `TRANSCRIPTION_MODEL` 保持服务 API 接受的模型名；只有网关或服务端模型名同步改变时才修改。
3. 将 `FUNASR_DEPLOYMENT_ID` 改为包含模型 revision/摘要的不可变值。

## 5. 版本、安全与许可

- 容器顶层 Python 依赖固定在 [`requirements-cpu.txt`](../deploy/funasr/requirements-cpu.txt)。构建后还应保存镜像 digest 和完整 `pip freeze`，因为间接依赖仍可变。
- 根目录 `.dockerignore` 只允许 FunASR Dockerfile 和依赖清单进入构建上下文，避免把 `.local` 凭据、源码工作副本或其他无关文件发送给 Docker daemon。
- 容器使用非 root 用户、只读根文件系、临时 `/tmp`、持久模型 volume 和 `no-new-privileges`。
- FunASR 工具代码和模型权重不是同一份许可。归属和一手链接见 [`deploy/funasr/NOTICE.md`](../deploy/funasr/NOTICE.md)。
- 当前默认不启用说话人分离。SenseVoiceSmall 自身不产生可跨切片一致的说话人身份，不能把分片内标签冒充全局人物识别。
- 官方服务会把单次上传读入服务进程内存。Podcast Worker 因此继续保留有上限的音频切片，不向模型服务上传整期长音频。

## 6. 当前验证状态

已验证：

- FunASR multipart 请求与 verbose JSON 归一化的自动化测试。
- 自托管 Provider 默认选择与付费 Provider 显式启用。
- `503` 后租约恢复并跳过已确认片段。
- `docker compose config` 对 CPU 部署文件的结构校验。

未验证：

- 当前开发机 Docker daemon 未运行，因此未在本轮构建镜像、下载权重或执行真实声学推理。
- 标准 Linux Server 上的 CPU 实时倍率、峰值内存、并发能力、中文 CER 和专有名词准确率。
- GPU 镜像、CUDA 匹配和调度。GPU 是后续增强，不是当前 CPU 基线的前置条件。
