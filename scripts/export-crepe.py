"""Export the upstream MIT-licensed CREPE tiny weights for browser inference.

Development only: pip install torchcrepe==0.0.24 onnx
The shipped frontend already includes the exported model.
"""
from pathlib import Path
import hashlib
import json
import torch
import torchcrepe

root = Path(__file__).resolve().parents[1]
output = root / "dist" / "models"
output.mkdir(parents=True, exist_ok=True)
torchcrepe.load.model("cpu", "tiny")
model = torchcrepe.infer.model
model.eval()
target = output / "crepe-tiny.onnx"
torch.onnx.export(model, torch.zeros(1, 1024), str(target), opset_version=17,
                  input_names=["frames"], output_names=["activations"],
                  dynamic_axes={"frames": {0: "batch"}, "activations": {0: "batch"}})
weights = Path(torchcrepe.__file__).parent / "assets" / "tiny.pth"
metadata = {
    "architecture": "CREPE tiny", "source": "https://github.com/maxrmorrison/torchcrepe",
    "source_version": "0.0.24", "license": "MIT", "opset": 17,
    "sample_rate": 16000, "frame_samples": 1024, "pitch_bins": 360,
    "weights_sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
    "onnx_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
}
(output / "crepe-tiny.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps({"model": str(target), "bytes": target.stat().st_size}))
