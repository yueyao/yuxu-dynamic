"""MLX兼容层契约测试：不导入GPU依赖，不下载模型。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


class MlxBridgeTest(unittest.TestCase):
    def test_context_conversion_preserves_segment_instead_of_joined_words(self):
        path = Path(__file__).parents[1] / "scripts/mlx-whisper.py"
        spec = importlib.util.spec_from_file_location("mlx_bridge", path)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        class ContextConverter:
            def convert(self, text):
                return {"乾隆": "乾隆", "乾": "干", "一目瞭然": "一目了然"}.get(text, text)
        for phrase, tokens, expected in (("乾隆", ["乾", "隆"], "乾隆"),
                                         ("一目瞭然", ["一目", "瞭然"], "一目了然")):
            with self.subTest(phrase=phrase):
                result = bridge.simplify_result({"text": phrase, "segments": [{"text": phrase,
                    "words": [{"start": i, "end": i+1, "word": token}
                              for i, token in enumerate(tokens)]}]}, ContextConverter())
                self.assertEqual(result["text"], expected)
                self.assertEqual(result["segments"][0]["text"], expected)
                # 不伪造词边界；上下文差异由现有对齐器回退为整段对齐。
                self.assertNotEqual("".join(w["word"] for w in result["segments"][0]["words"]), expected)

    def test_check_reports_dependencies_without_inference_or_audio(self):
        path = Path(__file__).parents[1] / "scripts/mlx-whisper.py"
        spec = importlib.util.spec_from_file_location("mlx_bridge", path)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        import contextlib
        import io
        output = io.StringIO()
        modules = {"mlx_whisper": types.SimpleNamespace(),
                   "opencc": types.SimpleNamespace(OpenCC=object)}
        with patch("importlib.metadata.version", return_value="test-version"), \
                patch.dict("sys.modules", modules), \
                contextlib.redirect_stdout(output):
            bridge.main(["--check"])
        report = json.loads(output.getvalue())
        self.assertTrue(report["dependencies"])
        self.assertFalse(report["inference_verified"])
        self.assertIn("mlx-whisper", report["packages"])

    def run_bridge(self, words=True):
        path = Path(__file__).parents[1] / "scripts/mlx-whisper.py"
        spec = importlib.util.spec_from_file_location("mlx_bridge", path)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        calls = []
        def transcribe(audio, **kwargs):
            calls.append((audio, kwargs))
            return {"text": " 頭髮， hello!", "language": "zh", "segments": [
                {"start": 0, "end": 2, "text": " 頭髮， hello!", "words": [
                    {"start": 0, "end": 1, "word": " 頭髮，"},
                    {"start": 1, "end": 2, "word": " hello!"}]}]}
        class Converter:
            def __init__(self, config):
                self.config = config
            def convert(self, text):
                return text.replace("頭髮", "头发")
        modules = {"mlx_whisper": types.SimpleNamespace(transcribe=transcribe),
                   "opencc": types.SimpleNamespace(OpenCC=Converter)}
        with tempfile.TemporaryDirectory() as directory:
            args = ["audio.wav", "--output_dir", directory, "--model", "small", "--language", "zh",
                    "--initial_prompt", "中文", "--word_timestamps", str(words)]
            with patch.dict("sys.modules", modules):
                bridge.main(args)
            output = json.loads((Path(directory) / "audio.json").read_text())
            with patch.dict("sys.modules", modules):
                with self.assertRaises(FileExistsError):
                    bridge.main(args)
        return calls[0], output

    def test_forwards_words_and_preserves_simplified_word_text(self):
        call, output = self.run_bridge()
        self.assertTrue(call[1]["word_timestamps"])
        self.assertEqual(call[1]["path_or_hf_repo"], "mlx-community/whisper-small-mlx")
        self.assertEqual(call[1]["initial_prompt"], "中文")
        segment = output["segments"][0]
        self.assertEqual(segment["words"][0]["word"], " 头发，")
        self.assertEqual("".join(w["word"] for w in segment["words"]), segment["text"])
        self.assertEqual(segment["text"], output["text"])

    def test_false_flag_is_false_in_model_call(self):
        call, _ = self.run_bridge(False)
        self.assertFalse(call[1]["word_timestamps"])


if __name__ == "__main__":
    unittest.main()
