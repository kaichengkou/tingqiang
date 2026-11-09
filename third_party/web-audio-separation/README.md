# 浏览器分离代码来源

来源：https://github.com/incidentist/web-audio-separation

固定提交：`d412f5a45e34bf73883516b7fcc4561c95c028bf`，MIT，2026 Dan Kurtz。

保留源码和嵌入 PFFFT WASM。许可见项目 `licenses/web-audio-separation-MIT.txt`、`licenses/pffft-LICENSE.txt`；构建后一起分发到 `dist/licenses/`。

本项目的适配：允许直接传入已校验的模型字节；公开 demix 方法，绕过文件和音量处理包装；固定使用本地 ONNX Runtime 1.20.1 WASM 文件，线程数和后端由调用方决定（客户端另打一份走 WebGPU 的包），并增加测速与释放模型的方法；在单独 worker 中运行，由主应用负责取消、缓存、输入重采样、输出与模型选择。

上游文档要求较新的 ORT。本适配只使用已验证可由 ORT 1.20.1 执行的 UVR_MDXNET_KARA_2（opset 13），不声称支持上游所有模型。人声与伴奏在同一音量域求差，输出采用共同增益，避免分别归一化改变声部比例。

模型权重不包含在源码包；用户主动点击后，按 `dist/models/separation.json` 下载固定版本并验证 SHA-256。录音不上传，缓存仅包含公开模型。
