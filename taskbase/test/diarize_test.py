"""不下载模型的桥接契约测试。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import types
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("diarize", Path(__file__).parents[1] / "scripts/diarize.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def test_reject_cloud_model_and_arbitrary_pipeline(self):
        with self.assertRaises(ValueError):
            bridge.validate_model("pyannote/speaker-diarization-precision-2")
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            config.write_text("pipeline:\n  name: pyannote.audio.pipelines.RemotePipeline\n")
            with self.assertRaises(ValueError):
                bridge.validate_local_config(config)

    def test_turns_and_metadata_no_token(self):
        class Turn:
            start, end = 0.0, 1.0
        class Annotation:
            def itertracks(self, yield_label=False):
                yield Turn(), 0, "SPEAKER_00"
                yield Turn(), 1, "SPEAKER_01"
        class Output:
            speaker_diarization = Annotation()
        result = bridge.serialize_output(Output(), "test", "cpu", "sha", {"pyannote.audio": "4.0.7"})
        self.assertEqual(len(result["turns"]), 2)
        self.assertEqual(result["metadata"]["revision"], "sha")
        self.assertNotIn("token", json.dumps(result))

    def test_errors_do_not_echo_credentials(self):
        with patch.dict("os.environ", {"HF_TOKEN": "hf_private_value"}):
            self.assertNotIn("hf_private_value", bridge.safe_error(RuntimeError("hf_private_value")))

    def test_pipeline_parameters_file_output_and_telemetry(self):
        calls = []
        class Annotation:
            def itertracks(self, yield_label=False):
                yield types.SimpleNamespace(start=0, end=2), 0, "SPEAKER_00"
        class Pipeline:
            @classmethod
            def from_pretrained(cls, config, token=None):
                calls.append((config, token))
                return cls()
            def to(self, device):
                calls.append(device)
            def __call__(self, audio, **kwargs):
                calls.append(kwargs)
                return types.SimpleNamespace(speaker_diarization=Annotation())
        modules = {"torch": types.SimpleNamespace(device=lambda value: value),
                   "pyannote": types.ModuleType("pyannote"),
                   "pyannote.audio": types.SimpleNamespace(Pipeline=Pipeline)}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            argv = ["diarize.py", "--input", "audio.wav", "--output", str(output), "--num-speakers", "2"]
            with patch.dict("sys.modules", modules), patch.object(bridge.sys, "argv", argv), \
                    patch.object(bridge, "resolve_model", return_value=("local/config.yaml", "fixed")), \
                    patch.object(bridge.importlib.metadata, "version", return_value="4.0.7"), \
                    patch.dict("os.environ", {"HF_TOKEN": "fake-private"}):
                bridge.main()
                self.assertEqual(bridge.os.environ["PYANNOTE_METRICS_ENABLED"], "0")
            result = json.loads(output.read_text())
            self.assertEqual(result["metadata"]["revision"], "fixed")
            self.assertEqual(calls[-1], {"num_speakers": 2})
            self.assertEqual(calls[0], ("local/config.yaml", "fake-private"))
            self.assertNotIn("fake-private", output.read_text())


if __name__ == "__main__":
    unittest.main()
