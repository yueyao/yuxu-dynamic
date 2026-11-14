#!/usr/bin/env python3
"""community-1 本地推理桥接。stdout 仅检查报告，正式结果写入受控 JSON 文件。"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys

MODEL = "pyannote/speaker-diarization-community-1"


def safe_error(error):
    # 上游异常可能包含请求凭据；仅输出异常类型和操作指引。
    return (f"DIARIZATION_FAILED ({type(error).__name__}): 检查独立 Python 依赖、ffmpeg、"
            "Hugging Face 模型条款/授权及模型缓存；完整安装说明见 docs/transcription-v2.md")


def validate_model(model):
    if model != MODEL and not Path(model).is_absolute():
        raise ValueError("only community-1 or an absolute local model path is supported")


def validate_local_config(config):
    import yaml
    data = yaml.safe_load(Path(config).read_text())
    pipeline = data.get("pipeline", {}) if isinstance(data, dict) else {}
    if pipeline.get("name") != "pyannote.audio.pipelines.SpeakerDiarization":
        raise ValueError("local model must be a local SpeakerDiarization pipeline")
    return config


def resolve_model(model, revision, offline):
    validate_model(model)
    if Path(model).is_absolute():
        config = Path(model) / "config.yaml" if Path(model).is_dir() else Path(model)
        validate_local_config(config)
        import hashlib
        # 本地模型缓存身份包含文件内容，不只依赖路径或mtime。
        digest = hashlib.sha256()
        for file in sorted(config.parent.rglob("*")):
            if file.is_file() and ".cache" not in file.parts:
                digest.update(str(file.relative_to(config.parent)).encode())
                with file.open("rb") as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(block)
        return str(config), digest.hexdigest()
    from huggingface_hub import snapshot_download
    directory = Path(snapshot_download(model, revision=revision, local_files_only=offline))
    config = directory / "config.yaml"
    validate_local_config(config)
    return str(config), directory.name


def serialize_output(output, model, device, revision, packages):
    turns = [{"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
             for turn, _, speaker in output.speaker_diarization.itertracks(yield_label=True)]
    return {"turns": turns, "metadata": {"provider": "pyannote", "model": model,
            "device": device, "revision": revision, "packages": packages}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--revision", default="main")
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], default="cpu")
    parser.add_argument("--num-speakers", type=int)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--check", action="store_true", help="只检查依赖，不下载模型")
    parser.add_argument("--prepare", action="store_true", help="下载/加载模型；不会转写音频")
    parser.add_argument("--resolve-only", action="store_true", help="解析模型revision作为检查点身份")
    args = parser.parse_args()
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    validate_model(args.model)
    if args.num_speakers is not None and args.num_speakers < 1:
        raise ValueError("num-speakers must be positive")
    import torch
    from pyannote.audio import Pipeline
    packages = {name: importlib.metadata.version(name) for name in ("pyannote.audio", "torch", "torchaudio", "torchcodec")}
    if not packages["pyannote.audio"].startswith("4."):
        raise ValueError("pyannote.audio 4.x required")
    if args.check:
        print(json.dumps({"dependencies": True, "model_verified": False, "packages": packages}))
        return
    if not args.prepare and not args.resolve_only and (not args.input or not args.output):
        parser.error("--input and --output required")
    config, revision = resolve_model(args.model, args.revision, args.offline)
    if args.resolve_only:
        print(json.dumps({"revision": revision, "packages": packages}))
        return
    pipeline = Pipeline.from_pretrained(config, token=os.environ.get("HF_TOKEN"))
    if pipeline is None:
        raise RuntimeError("model could not be loaded")
    pipeline.to(torch.device(args.device))
    if args.prepare:
        print(json.dumps({"model_loaded": True, "inference_verified": False, "revision": revision, "packages": packages}))
        return
    kwargs = {"num_speakers": args.num_speakers} if args.num_speakers else {}
    output = pipeline(args.input, **kwargs)
    result = serialize_output(output, args.model, args.device, revision, packages)
    destination = Path(args.output)
    # 临时目录由调用方创建，禁止覆盖既有文件。
    with destination.open("x", encoding="utf-8") as target:
        json.dump(result, target, ensure_ascii=False, allow_nan=False)
    destination.chmod(0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(safe_error(error), file=sys.stderr)
        sys.exit(1)
