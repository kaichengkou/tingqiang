# 开源来源与算法参考

- **Demucs 4.0.1**：https://github.com/facebookresearch/demucs ，MIT License，Meta Platforms, Inc. and affiliates。仅在用户选择本地增强服务时安装并运行；前端包不包含模型权重或第三方模型代码。使用其官方 `htdemucs` 预训练模型，首次运行从上游下载。许可副本见 `licenses/demucs-MIT.txt`。
- **PyTorch / torchaudio**：https://pytorch.org/ ，各自 BSD 风格许可证；作为可选分离依赖安装。
- **SoundFile**：https://github.com/bastibe/python-soundfile ，BSD-3-Clause；系统／wheel 所带 libsndfile 使用 LGPL，见上游分发声明。
- **FastAPI**：https://github.com/fastapi/fastapi ，MIT；**Uvicorn**：https://github.com/encode/uvicorn ，BSD-3-Clause；**python-multipart**：https://github.com/Kludex/python-multipart ，Apache-2.0。由 Python 包管理器安装，未复制源码。
- **Playwright Core**：https://github.com/microsoft/playwright ，Apache-2.0，仅用于开发验证。
- **Noto Serif SC**：https://fonts.google.com/noto/specimen/Noto+Serif+SC ，SIL Open Font License 1.1，通过 Google Fonts 引用；离线时使用系统宋体，前端功能不依赖外部字体。
- **YIN 思路参考**：A. de Cheveigné, H. Kawahara, “YIN, a fundamental frequency estimator for speech and music”, JASA 111(4), 2002, https://doi.org/10.1121/1.1458024 。当前 JavaScript 是自行实现的 FFT 辅助差分／周期估计，并非复制某个项目的代码，也不声称复现原论文全部细节。

示范音频由本项目按正弦波、滑音和颤音合成，没有使用京剧录音。非商用也应保留所使用开源组件的许可；如将来分发模型或打包第三方运行时，应同时检查相应版本的完整许可与声明。

## v0.2 浏览器音高模型

- **CREPE / CREPE tiny pretrained model**：https://github.com/marl/crepe ，MIT，Jong Wook Kim 等。原始架构和权重；许可见 `licenses/crepe-MIT.txt`。
- **torchcrepe 0.0.24**：https://github.com/maxrmorrison/torchcrepe ，MIT，Max Morrison。导出 tiny 权重（来源和哈希见 `dist/models/crepe-tiny.json`）；许可见 `licenses/torchcrepe-MIT.txt`。参考其标准化和三角转移 Viterbi 解码，在 JavaScript 中实现确定性的局部加权频率细化，无随机抖动。
- **ONNX Runtime Web 1.20.1**：https://github.com/microsoft/onnxruntime ，MIT，Microsoft Corporation。前端自托管运行库与 WASM；许可及第三方声明分别见 `licenses/onnxruntime-MIT.txt`、`licenses/onnxruntime-ThirdPartyNotices.txt`。
- **对照算法（未复制其代码）**：https://github.com/librosa/librosa 的 pYIN，用于本地对照这份清唱；未作为默认前端依赖。RMVPE（https://github.com/Dream-High/RMVPE）也作为后续候选调研，本版未集成或实测 RMVPE。

## v0.3 浏览器伴奏抑制与显示处理

- **web-audio-separation**：https://github.com/incidentist/web-audio-separation ，固定提交 d412f5a45e34bf73883516b7fcc4561c95c028bf，MIT，2026 Dan Kurtz。源码与修改说明在 third_party/web-audio-separation/；许可在 licenses/web-audio-separation-MIT.txt，并随发布的 dist/licenses/ 分发。
- **PFFFT**：https://github.com/marton78/pffft ，固定提交 a4b03590cc2a4bea56f9721996e3057835799179。上游浏览器库所带 WASM 使用该 FFT；完整许可见 licenses/pffft-LICENSE.txt，随站点分发。
- **UVR_MDXNET_KARA_2 模型**：由公开 Hugging Face 仓库 AI4future/RVC 的固定版本下载，该仓库声明 MIT。下载地址、仓库提交、参数、大小和 SHA-256 见 dist/models/separation.json。模型权重不在源码包或站点资产内；首次由用户主动下载并缓存在本机。模型来源参考 https://github.com/Anjok07/ultimatevocalremovergui 。
- **esbuild**：https://github.com/evanw/esbuild ，MIT，只用于把已有许可的浏览器分离源码打包。
- 显示平滑自行实现二次局部多项式拟合；形状保持三次绘制自行实现，不依赖或复制额外平滑库。原始模型结果保持独立，插值仅作为明确标识的学习参考。

## v0.4 注音与字表

- **pinyin-pro 3.29.5**：https://github.com/zh-lx/pinyin-pro ，MIT。用于普通话上下文注音，在构建时打包为 dist/vendor/pinyin.mjs；不调用外部注音服务。许可见 licenses/pinyin-pro-MIT.txt，随 dist/licenses/ 分发。
- **用户提供的上口／尖团字参考项目**：从上传归档中「京剧音韵资料/index.html」的 DATA 数据提取尖团与上口条目，保留原始候选、韵部和调类；未执行归档代码，未采用旧项目的完整唱词库。当前用于用户授权的私有试用，原项目数据未附明确的开放许可；不将这些字表声明为 MIT 或公共领域。来源及处理边界见 docs/validation-v04.md。

## v0.7 Windows 客户端

- **Electron 45.2.1**：https://github.com/electron/electron ，MIT。随安装包分发，内含 Chromium、Node.js 和 FFmpeg 等组件；许可随程序放在 `LICENSE.electron.txt`、`LICENSES.chromium.html`。
- **electron-builder 26.18.0**：https://github.com/electron-userland/electron-builder ，MIT，只用于构建。安装程序由 NSIS 生成（zlib 许可）。
- **ONNX Runtime Web 1.20.1 的 WebGPU 文件**：与上文同一版本、同一许可，用于客户端的显卡加速。
- **UVR_MDXNET_KARA_2 模型**：客户端安装包内含权重，不再是用户自行下载，这是与网页版的区别。上游 Hugging Face 仓库声明 MIT，模型来自 UVR 项目。**公开分发安装包前，应再向模型来源确认分发条款**；上文的上口字表同样尚无明确的开放许可。

## v0.8 安卓 App

- **ONNX Runtime Android 1.31.1**：https://github.com/microsoft/onnxruntime ，MIT，来自 Maven Central 的 `com.microsoft.onnxruntime:onnxruntime-android`（SHA-1 3c0fccc45f50e684c9d79a8f016f674488377223）。APK 内含它的 Java 类和 arm64-v8a 原生库，用于在手机上运行分离模型。许可与上文 ONNX Runtime Web 相同，见 licenses/。它的 AAR 清单申请 INTERNET 并注册遥测组件，这里不合并第三方清单，两者都不进 App。
- **Eclipse Temurin JDK 21、Android SDK Build-Tools 36.1.0、Android 16 Platform**：只用于构建，不随 App 分发。SDK 组件按《Android Software Development Kit License Agreement》使用。
- **Android System WebView**：手机系统自带，App 不打包浏览器内核。
- **UVR_MDXNET_KARA_2 模型**：与 Windows 客户端一样随 APK 分发，公开发布前同样需要确认分发条款。

## v0.5 实时移调

- **Signalsmith Stretch Web 1.3.2**：https://www.npmjs.com/package/signalsmith-stretch ，上游 https://github.com/Signalsmith-Audio/signalsmith-stretch ，MIT，Geraint Luff / Signalsmith Audio Ltd。固定 npm 版本的 JS／WASM／AudioWorklet 打包在 dist/vendor/signalsmith-stretch.mjs，许可见 licenses/signalsmith-stretch-MIT.txt 并随站点分发。使用实时输入模式，按报告延迟补偿画面；未修改上游库。
