#!/usr/bin/env python3
"""MLX Whisper JSON桥接；显式保留词时间戳和简体词文本。"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys

MODELS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo": "mlx-community/whisper-large-v3-turbo",
}


def boolean(value):
    if value.lower() not in ("true", "false"):
        raise argparse.ArgumentTypeError("expected True or False")
    return value.lower() == "true"


def simplify_result(result, converter):
    result["text"] = converter.convert(result.get("text") or "")
    for segment in result.get("segments") or []:
        original = segment.get("text") or ""
        words = segment.get("words") or []
        for word in words:
            word["word"] = converter.convert(word.get("word") or "")
        # 例如“乾隆”拆词后会变成“干隆”；正文始终按整段上下文转换。
        # 词拼接不一致时由alignSpeakers回退整段对齐，不用词文本覆盖正文。
        segment["text"] = converter.convert(original)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", nargs="?")
    parser.add_argument("--model", default="small")
    parser.add_argument("--output_dir")
    parser.add_argument("--output_format", choices=["json"], default="json")
    parser.add_argument("--language", default=None)
    parser.add_argument("--task", choices=["transcribe"], default="transcribe")
    parser.add_argument("--initial_prompt", default=None)
    parser.add_argument("--word_timestamps", type=boolean, default=False)
    parser.add_argument("--device", default="mlx")
    parser.add_argument("--fp16", type=boolean, default=False)
    parser.add_argument("--verbose", type=boolean, default=False)
    parser.add_argument("--check", action="store_true", help="只导入依赖，不加载模型或转写音频")
    args = parser.parse_args(argv)
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if not args.check and (not args.audio or not args.output_dir):
        parser.error("audio and --output_dir required")
    import mlx_whisper
    from opencc import OpenCC
    if args.check:
        packages = {name: importlib.metadata.version(name)
                    for name in ("mlx-whisper", "opencc-python-reimplemented")}
        print(json.dumps({"dependencies": True, "inference_verified": False, "packages": packages}))
        return
    result = mlx_whisper.transcribe(
        args.audio, path_or_hf_repo=MODELS.get(args.model, args.model),
        language=None if args.language == "auto" else args.language,
        task=args.task, initial_prompt=args.initial_prompt,
        word_timestamps=args.word_timestamps, verbose=None,
        condition_on_previous_text=False,
    )
    result = simplify_result(result, OpenCC("t2s"))
    directory = Path(args.output_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = directory / (Path(args.audio).stem + ".json")
    # 临时目录由调用方管理，不覆盖既有结果。
    with output.open("x", encoding="utf-8") as target:
        json.dump(result, target, ensure_ascii=False, allow_nan=False)
    output.chmod(0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 上游下载异常可能含认证URL；只报告类型，凭据不写日志。
        print(f"MLX_WHISPER_FAILED ({type(error).__name__}): 检查MLX环境、模型缓存和Apple GPU；见docs/transcription-v2.md", file=sys.stderr)
        sys.exit(1)
