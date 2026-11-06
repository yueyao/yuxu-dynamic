# FunASR 与 SenseVoiceSmall 归属说明

本部署配置使用以下第三方项目，但不在本仓库中分发模型权重：

- FunASR toolkit：由 FunASR 项目及其贡献者维护，源代码使用 MIT License。
- SenseVoiceSmall：模型名称为 `SenseVoiceSmall`，模型卡标识为 `iic/SenseVoiceSmall` / `FunAudioLLM/SenseVoiceSmall`，权重使用 FunASR Model Open Source License Agreement 1.1。
- 模型协议要求保留来源、作者信息和相关模型名称。部署者必须在上线前阅读并确认当时有效的模型卡和协议。

一手来源：

- <https://github.com/modelscope/FunASR>
- <https://github.com/modelscope/FunASR/blob/main/LICENSE>
- <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>
- <https://huggingface.co/FunAudioLLM/SenseVoiceSmall>

当前容器首次启动时会从配置的模型中心下载权重到 `funasr-model-cache` volume。如果部署要求完全离线和可重现，应将审核后的完整模型快照预置到只读目录，记录上游 revision 和文件 SHA-256，并让服务的 `--model` 指向本地目录。
