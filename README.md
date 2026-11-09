# 听腔 · 京剧唱腔练习 v0.8

这是可试用的基础版本。发布后的前端无需构建或商业音频 API；可选的浏览器实验功能使用 UVR／MDX 模型做人声分离；Python 增强服务也保留了 Demucs。这不是覆盖各行当、流派的准确率评测。内置示范仍为合成音。

## 已经实现

- 导入浏览器可解码的 MP3、WAV、M4A、OGG 等录音，播放、定位。
- 本机练习库：自动保存原录音、分轨、曲线、唱词校订、调门、速度和位置，刷新恢复最近练习；支持 .tqproj 练习包备份、导入及删除。
- 逐句练习：点唱词自动选择本句区间；可重复听或听唱交替，设置遍数和间隔，听完自动留出跟唱时间。
- 跟着伴奏唱：选一句或一段，戴耳机点「跟着伴奏唱」。伴奏提前几秒进入并倒数，边唱边显示蓝色音高线，唱到句尾自动停；录完可听「合成」（人声加伴奏）并下载。支持与移调、慢放组合，单遍最长 10 分钟。蓝牙等延迟大的设备可用「延迟校准」拍手测一次。
- 自己的录音：也可清唱录一遍（单遍最多两分钟），或导入不超过十分钟的录音。每个练习最多保存 20 遍；支持原唱／自己切换、蓝色音高叠加、时间偏移校准、自动对齐、下载与删除。
- 调门 ±6 半音，保持速度；Signalsmith Stretch 在 AudioWorklet 中处理，原唱曲线同步移调，自己的录音保留实际唱出的音高。支持与慢放组合。
- 导入后自动分析，期间可以播放和定位；曲线边算边显示，优先算正在听的位置。默认在多个 Web Worker 中并行运行 CREPE tiny 音高模型，再做连续跟踪，20 ms 步长；在本机计算，首次加载约 13 MB 的模型与运行组件。保留滑音与颤音，静音和低置信度区段留空。可选原有快速周期分析；可调整 50–2000 Hz 内的检测音域。
- 原声／人声／伴奏切换，保持播放位置；后两个声部只在分离成功或导入对应分轨后可用。
- “减弱伴奏”：客户端自带模型，优先用显卡。网页版是实验功能，主动点击后下载并缓存约 53 MB UVR／MDX 模型，在 Worker 中分块处理，录音不上传；完成后自动分析人声。支持 10 分钟以内片段，可以取消；长段建议在电脑处理。
- 学唱曲线：默认轻度平滑并保留颤动，连接不超过 0.2 秒且两端相近的短缺口。浅色连接是过渡参考；静音、长停顿、大跳变不连接。可选择原始识别或关闭连接，无需重新分析。
- A/B 循环、拖动曲线选段、0.5×–1.25× 保调变速、4／8／16／32 秒连续滚动视野，默认 8 秒，当前播放位置固定在中央（包括曲首、曲尾）。
- 原录音上的实验性固定节拍估计、手动点拍与 BPM 网格，可关闭。未实现自动京剧板式和板眼判断。
- 曲线下的唱词字幕：UTF-8／GB18030 导入；普通 LRC 跟随到句、增强 LRC 根据已有时间跟随到字／词；空时间戳或句尾增强标记可结束字幕。TXT 支持逐句手工打时间点，不猜测逐字对齐。可隐藏／显示字幕。
- “从首句唱起”：优先使用唱词首句时间；没有带时间戳的唱词时，使用分析声部的持续有声音高起点估计，并提前 0.12 秒。原声中的乐器可能影响估计，界面标明来源。
- 接入用户提供的上口／尖团字表。字幕与唱词列表仅上口字标红并在字上方注音，其余字显示普通文字。普通话上下文注音与尖团读法留在校音窗口供参考；多读法保留候选，支持按出现位置校音和恢复字表，不从录音推断实际读法。
- 视听同步：曲线、字幕、当前音高共用输出时钟，按浏览器可报告的音频输出延迟自动补偿；可按 20 ms 微调，范围 ±1000 ms，慢放时换算到原录音时间。
- 桌面和手机布局；也有 Windows 客户端和安卓 App，见下文。

## Windows 客户端

不需要浏览器、Python 或网络：双击 `release/听腔-安装程序-0.8.0.exe` 安装，从桌面图标打开。界面和算法与网页版是同一份，另外多了这些：

- 「减弱伴奏」不用下载模型，也快得多。有独立显卡时，112 秒唱段约 12–18 秒；只用 CPU 约 100 秒。网页版单线程约 10 分钟。实测见 [docs/validation-v07.md](docs/validation-v07.md)。
- 麦克风不用逐次授权。如果 Windows 隐私设置禁止了麦克风，程序会说明原因，并提供打开设置的按钮。
- 双击 `.tqproj` 练习包直接打开，可以把录音、唱词或练习包拖进窗口；窗口最小化后，循环和跟唱照常进行。
- 程序不联网。录音和练习只在这台电脑的 `%APPDATA%\TingQiang`，卸载时不会删除。

目前只有 Windows 10／11 x64 版本，没有代码签名，也没有自动更新。第一次运行时 Windows 可能提示「已保护你的电脑」，点「更多信息」→「仍要运行」。新版本覆盖安装即可，数据保留。

需要 Node 22 以上才能构建。`node_modules` 和中间文件放在 `%LOCALAPPDATA%\tingqiang-build`，避开 OneDrive：

```bash
npm run desktop:build
```

安装包生成在 `release/`。`npm run desktop` 不打包，直接运行。

## 安卓 App

把 `release/听腔-0.8.0.apk` 发到手机（微信、数据线都可以），点开安装。第一次装时手机会要求允许「安装未知应用」，按提示允许一次。需要 Android 8.0 以上的 64 位手机（近几年的手机都是），系统的 Android System WebView 版本在 100 以上；太旧时 App 会提示更新。界面和功能与电脑上是同一份，另外有这些：

- 「减弱伴奏」：模型装在 App 里，由 App 用手机的多个核心直接运算，录音不上传。模拟器里 112 秒唱段约 1 分钟；手机自带的网页组件只能单线程，那样要十几分钟。真手机上的速度还没有测过。
- 在微信、文件管理器里「用其他应用打开」录音或 `.tqproj` 练习包，或者「分享」给听腔；导出练习包、录音和合成时，可以「发送给…」微信等，也可以「保存到手机…」。
- 锁屏或切到别的应用时，播放、逐句练习和减弱伴奏照常进行。录音会停下并保留已录的部分，因为安卓不让后台应用使用麦克风。
- 不联网：安装时就不申请网络权限。练习保存在 App 自己的存储里，**卸载 App 会删除练习**，换手机前请先导出练习包。
- 返回键先关窗口、停录音，再把 App 退到后台；转屏、调大系统字体不会打断练习。

目前只在电脑的安卓模拟器里测试过，没有在真手机上测过；也没有上架应用商店。iPhone 版需要在 Mac 上用 Xcode 构建，这里做不了；华为鸿蒙 NEXT 不能安装 APK。

构建不需要 Android Studio 或 Gradle，只要下面这些，放在 `%LOCALAPPDATA%\tingqiang-build\android`（避开 OneDrive）：

| 放到 | 文件 | 来源 |
| --- | --- | --- |
| `jdk/` | OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip 解压 | github.com/adoptium |
| `sdk/build-tools/36.1.0/` | build-tools_r36.1_windows.zip 解压（压缩包里的 `android-16` 改名） | dl.google.com/android/repository |
| `sdk/platforms/android-36/` | platform-36_r02.zip 解压 | 同上 |
| `cache/onnxruntime/` | onnxruntime-android-1.31.1.aar（SHA-1 3c0fccc45f50e684c9d79a8f016f674488377223；没有时构建脚本自动下载并核对） | Maven Central |

```bash
npm run android:build
```

安装包生成在 `release/`。`node scripts/build-android.mjs install` 构建可调试的版本并装到 adb 连接的手机或模拟器，`run` 装完再打开。

签名：默认用第一次构建时生成的开发密钥 `keys/development.jks`（在上面的文件夹里）。只有同一把密钥签名的新版本才能覆盖安装，换电脑构建前要带上这个文件。上架或公开发布前要换成自己的发布密钥（环境变量 `TINGQIANG_KEYSTORE`、`TINGQIANG_KEYSTORE_PASSWORD`、`TINGQIANG_KEY_ALIAS`），以后一直用它；已经装了开发版的手机要先卸载才能装正式版。

## 先试浏览器版

已发布的私有试用站可以直接导入录音、分析和练习。练习保存在当前浏览器的 IndexedDB；保存状态在页眉显示，录音不上传。清除网站数据或更换浏览器不会保留练习，建议在练习库导出 .tqproj 备份。导入备份会创建独立练习。前端还记住增强服务地址、字幕显隐和视听同步偏好。

常用操作集中在曲线下方：播放、速度、调门和 A/B。右侧为逐句练习和唱词，下方为录音对照；手机固定显示播放栏。检测音域、算法、平滑和节拍设置收进设置窗口。

录音只在点击录音按钮后请求麦克风权限，不通过扬声器监听麦克风；停止后释放设备。清唱时参考录音暂停，跟唱时播放所选音源，请戴耳机，以免把音乐录进去。导入自己的录音时，以当前选段起点和速度作为初始对齐参考，可调整秒数偏移。蓝线只作比较，不自动评价字、气、韵或流派。较大的移调仍可能改变音色。

直接分析原录音可能识别到乐器。要降低干扰，可在「音源与分离设置」中导入同一起点、同长度的人声文件，再点「开始分析」。网页可点击“减弱伴奏 · 提取人声”尝试浏览器分离，无需 Python。首次从固定版本的公开 Hugging Face 地址下载约 53 MB 模型并校验 SHA-256；后续使用本机缓存。CPU 处理较慢，建议先试短片段。该模型未针对京剧专门训练，京胡等乐器可能仍有残留。长录音和浏览器无法处理时，可使用下述 Demucs 增强服务。

在自己电脑上运行：Windows 双击 `启动听腔.bat`，或运行下面的命令，都会打开 `http://localhost:8000`。不用安装 Node 或 Python 音频库。

```bash
python scripts/serve.py 8000 --open
```

## 本地增强版（Demucs，可处理长片段）

需要 Python 3.12、FFmpeg 和 FFprobe。下面是已验证的 Linux CPU 安装方式：

```bash
python -m venv .venv
.venv/bin/python -m pip install torch==2.5.1+cpu torchaudio==2.5.1+cpu --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install -r server/requirements-separation.txt
.venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8000
```

打开 `http://localhost:8000`。前端会自动检测同源服务。导入真实录音后，打开「音源与分离设置」，点击「分离人声与伴奏」。首次处理会下载 `htdemucs` 模型；CPU 处理长录音较慢。完成后自动切换到人声分析，三个播放档位都可用。

Windows 使用 `.venv\Scripts\python.exe` 替代 `.venv/bin/python`，并将 FFmpeg 放进 PATH。macOS 可安装对应平台的 `torch==2.5.1 torchaudio==2.5.1`，然后安装分离依赖。其他平台尚未实测。

如果暂时不要分离模型，安装 `server/requirements.txt` 就能用同一个启动命令运行基础服务。

### 运行约束

- 前端录音上限 150 MB／30 分钟；增强分离服务上限 100 MB／20 分钟。
- 服务默认只绑定本机。音频任务保存在 `.runtime/`，完成后一小时自动清理；取消任务会删除文件。
- 模型首次下载需要联网，之后可使用本地缓存。`TINGQIANG_DEVICE=cuda` 可选择已配置的 CUDA 设备；本次只验证 CPU。
- 如果前端与增强服务分开部署，服务需可通过 HTTPS 访问，并在 `TINGQIANG_ALLOWED_ORIGINS` 中列出前端的准确来源，以逗号分隔；前端设置中填写服务地址。本地使用同源页面最简单。
- 不要直接把这个单用户原型的 Python 服务暴露到公网；共享部署前需补充用户隔离、认证和持久任务管理。

## 唱词文件

普通 LRC（整句高亮）：

```text
[00:02.30]第一句唱词
[00:12.80]第二句唱词
```

增强 LRC（按已有标记跟随到字）：

```text
[00:02.30]<00:02.30>一<00:04.00>字<00:06.50>拖<00:09.20>腔
```

纯文本每行一句。先导入录音，再导入对应唱词。播放到起句位置，点击句子右侧时钟即可标记；「校时」可以给全篇添加偏移。时间、字音校订随练习保存在本机。普通 LRC 只做逐句字幕，增强 LRC 的一个时间标记可对应一字或一词。

字幕中只有仍采用上口读法的字标红、注音并带点线，其他字不显示拼音；上口字改为「按普通话」后也恢复普通文字。注音采用源表读法和声调类别，部分是戏曲拟音，不能等同于普通话规范拼音。点击句旁「校音」可按当前唱段、字义和流派选择读法，查看普通话与尖团参考。字表不等于对录音中的实际发音识别。

如果曲线似乎比声音快，先用「视听微调」中的自动补偿。仍然领先时点「延后 20 ms」；落后时点「提前 20 ms」。蓝牙、浏览器和设备未报告的延迟需手动校准。唱词文件本身的时间误差另用「唱词时间微调」修正。

## 检查

```bash
npm ci
npm test
npm run check
```

单元测试覆盖已知音高、强泛音、滑音、静音、节拍脉冲、LRC 时间和 WAV 编码。浏览器检查使用系统 Chromium，先启动本地服务，再运行：

```bash
node tests/browser.mjs
node tests/browser-timing-lyrics.mjs
node tests/browser-studio.mjs
node tests/browser-pitch.mjs
node tests/browser-singalong.mjs
```

没有 `/usr/bin/chromium` 时（如 Windows），用环境变量 `CHROMIUM_PATH` 指向 Chrome 或 Edge；`TINGQIANG_TEST_URL` 可指定被测地址。

这些检查也能在打包好的客户端里运行：把 `TINGQIANG_TEST_EXE` 设为 `tingqiang.exe` 的路径，`TINGQIANG_TEST_URL` 设为 `tingqiang://app/`。客户端自身的检查（沙箱、打开文件、重启、系统对话框）是 `node tests/desktop.mjs`，同样需要 `TINGQIANG_TEST_EXE`，以及 FFmpeg。

安卓 App 的检查是 `node tests/android.mjs`：需要模拟器或打开 USB 调试的手机，先用 `node scripts/build-android.mjs install` 装上可调试的版本。它会走系统的文件选择、权限、保存和分享界面，以及锁屏、返回键和转屏。`TINGQIANG_TEST_RECORDING` 指向一段真实录音时，会再测导入、分析和减弱伴奏的耗时。模拟器的做法见 [docs/validation-v08.md](docs/validation-v08.md)。

Python 接口测试需要 `pip install httpx`，运行 `python -m unittest discover -s tests -p 'test_*.py'`。真实分离的端到端检查是 `node tests/separation.mjs`，需要安装模型依赖并启动服务，会真正运行 Demucs。

## 在 GitHub 上构建和发布

`.github/workflows/build.yml` 让 GitHub 自动做这些事：

- 每次推送代码：跑单元测试和语法检查（即上面的 `npm test`、`npm run check`）。
- 发新版本：先把 `package.json` 的 `version` 改成新版本号并推送，再推一个同名标签，例如：

  ```bash
  git tag v0.8.1
  git push origin v0.8.1
  ```

  GitHub 会构建 Windows 安装程序和安卓 APK，发布到仓库的 Releases 页面。标签和版本号不一致时会停下。也可以在网页的 Releases 里点 Draft a new release，新建同名标签（如 `v0.8.1`）并发布，构建完的安装包会自动加到这个版本里。
- 只想要测试包、不发布：在仓库的 Actions 页面选「检查与构建」，点 Run workflow。安装包附在这次运行里，保留 7 天。

Releases 里的文件名用英文（`TingQiang-Setup-<版本>.exe`、`TingQiang-<版本>.apk`），免得中文文件名在网页下载时出问题；页面上显示的名称是中文。

安卓 APK 要用同一把密钥签名，手机上才能覆盖安装。仓库的 Settings → Secrets and variables → Actions 里要有：

| 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 签名密钥文件（`.jks`）的 Base64 文本 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名，不设时用 `development` |

没有设置时，GitHub 用一次性密钥签名，这样的 APK 不能覆盖安装已有的听腔。将来换正式发布密钥时，改这三项即可。GitHub 构建出的 Windows 安装程序同样没有数字签名。

## 后续怎么改

前端：`dist/app.mjs`；音高与歌词处理：`dist/lib/analysis.mjs`；异步计算：`dist/analysis-worker.mjs`；分离服务：`server/app.py`。

数据和接口说明见 [docs/architecture.md](docs/architecture.md)。音高算法对照见 [docs/validation-famen.md](docs/validation-famen.md)，平滑、连线和浏览器分离验证见 [docs/validation-v03.md](docs/validation-v03.md)，本次字幕、字音、同步及长段处理说明见 [docs/validation-v04.md](docs/validation-v04.md)。后续需要更多真实唱段检验泛化效果。

练习库、录音、逐句跟练和降调的实现与检查见 [docs/validation-v05.md](docs/validation-v05.md)。减少等待和跟着伴奏唱的实测见 [docs/validation-v06.md](docs/validation-v06.md)。Windows 客户端见 [docs/validation-v07.md](docs/validation-v07.md)，安卓 App 见 [docs/validation-v08.md](docs/validation-v08.md)。

开源来源、许可和算法参考见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 音高模型来源和维护

音高模型使用 MIT 许可的 CREPE tiny，经 `torchcrepe==0.0.24` 权重导出为 ONNX（约 1.96 MB）。在浏览器中由 ONNX Runtime Web 运行，不发送录音。导出脚本是 `scripts/export-crepe.py`，模型来源和 SHA-256 记录在 `dist/models/crepe-tiny.json`。依赖和许可见 THIRD_PARTY.md 与 licenses/。

模型已经包含在源码包中。更新运行组件时运行 `npm ci && npm run prepare:assets`；重新导出模型仅开发时需要 `pip install torchcrepe==0.0.24 onnx`，然后执行 `python scripts/export-crepe.py`。

用户提供的录音不包含在源码或站点资产中。真实录音回归检查需自行提供原文件：`node tests/famen-recording.mjs /path/to/recording.mp3`。

## 浏览器分离来源与验证

浏览器分离使用 web-audio-separation 的固定提交，源码在 third_party/；编译脚本是 scripts/build-separator.mjs。只启用已实际验证的 UVR_MDXNET_KARA_2，模型地址、参数、大小和 SHA-256 在 dist/models/separation.json。模型权重不包含在源码中，用户主动点击时从上游下载，首次需要联网。

`npm run prepare:assets` 会复制 ORT 和许可文件，并重建分离与注音模块。真实浏览器分离流程测试是 `node tests/browser-separation.mjs /path/to/short-test.wav`；它会运行模型推理，不是假数据。可以用 `TINGQIANG_TEST_MODEL=/path/to/verified-model.onnx` 令测试从本地提供已核对的同一模型，以免受网络波动影响。
