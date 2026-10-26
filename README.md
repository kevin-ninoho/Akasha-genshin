# Akasha — 原神考据问答与知识工作台

Akasha 是一个开箱即用的原神资料检索与引用式问答桌面端。核心不是这个客户端，而是它背后持续整理的原神知识库：角色故事、语音、书籍、任务与活动文本都被整理成可检索的条目，再配上实体识别、多轮追问、复杂问题拆分和逐句溯源。你用中文提问，它给出结论，并标出每句话来自哪段原文。

**下载即用，不需要自备资料。** 桌面版已内置官方知识库接入：装好打开就能问，不用准备语料、不用跑本地模型、不用填任何密钥。

[下载 Windows 最新版](https://github.com/kevin-ninoho/Akasha-genshin/releases/latest)

*An open-source desktop client for a curated Genshin Impact knowledge base: natural-language questions, answers with cited sources, research planning, and local PV clip tools.*

> 非官方粉丝项目，与米哈游 / HoYoverse 无关联。知识库内容与游戏素材的权利归原权利方；本仓库与安装包都不分发游戏原始资料。

## 它解决什么问题

原神的设定散落在几十个角色的故事、语音、书籍、任务和活动文本里。认真考据一件事，往往要翻十几个来源、记版本差异，还容易记错出处；普通搜索给不出逐句依据，写考据或二创时最容易错在“记错版本、记错人”。

Akasha 把这些资料整理进可检索的知识库，并用一整套检索链路把问题和原文对齐：

- 角色名与外号识别、多轮追问承接、复杂问题拆分检索；
- 回答逐句对应到来源，点开就能核对原文，不需要盲信结论；
- 没有资料时明确拒答并提示原因，不编造看似有依据的答案。

## 项目的价值在哪里

开源的是客户端，以及检索、问答、考据工作台和 PV 剪辑的引擎（AGPL-3.0-only）。开源这一层，是为了让实现可审计、可自建、可二次开发；客户端本身只是承载能力的外壳。

真正让 Akasha 有用的是背后持续维护的知识库与检索质量：资料覆盖、条目整理、版本更新、外号与实体对齐、引用审计，这些都需要长期投入。**本仓库只放代码，服务地址、访问令牌、知识库数据与索引、模型权重都不在仓库里。**

- 想直接使用完整能力：下载桌面版，开箱即用。
- 想自己部署一套：见[自己搭一套](#自己搭一套开发者)。

## 下载桌面版

- Windows x64 安装版（推荐）或便携版：[最新 Release](https://github.com/kevin-ninoho/Akasha-genshin/releases/latest)
- 开箱即用：内置官方知识库接入，安装后直接打开即可提问，不需要准备资料、模型或密钥
- 连不上官方服务时，界面会明确提示未连接，不会编造没有依据的答案

## 主要功能

- **考据问答**：角色名与外号识别、多轮追问、复杂问题拆分检索；回答逐句标注来源，可核对原文。
- **资料覆盖**：角色档案、故事、语音、任务台词、书籍；可选观测枢图鉴侧车库（武器、圣遗物、材料、食物、敌人）。
- **考据工作台**：专题、培养规划、材料库存、研究时间线、角色关系；档案、语音、天赋、命座等结构化展示。
- **PV 片段整理**：为本机视频建立镜头索引、微调片段时间、预览原声，并导出最长 60 秒的 H.264/AAC MP4 片段。
- **本地用户数据**：专题、规划、材料库存、时间线等保存在本机 SQLite；安装包不打包知识库文件。

## 数据边界与隐私

- 桌面版的检索与问答请求会发送到 Akasha 官方知识库服务；**安装包内置了接入配置**。这是“开箱即用”的实现方式，也是知识库不随安装包分发、可以持续更新的做法。
- 安装包与仓库都不包含游戏原始数据、观测枢正文、知识库数据库或索引、参考媒体、模型权重。
- 你的个人数据（专题、规划、材料库存、时间线、窗口状态等）只保存在本机。
- 自建部署时，所有服务默认只绑定 `127.0.0.1`，检索与问答可以完全离线。

## 自己搭一套（开发者）

以下路线面向自行部署：**需要自备有权使用的语料，本地模型为可选**。官方桌面版不需要这些步骤。

### 运行源码

自建时，桌面版只读取本机配置的资料目录，不随包分发资料或素材。所有本机界面请求经鉴权的 `/v1` 代理。

> **数据边界：** 本仓库**不包含任何游戏数据、观测枢正文、考据作品、知识库媒体或模型**（仓库内仅有客户端 UI 使用的二创背景图，见[素材说明](client/web/chat/ASSET_CREDITS.md)）。
> 自行部署时，你需要自己准备有权使用的数据，并自行承担数据使用与分发的合规责任。
> 代码提供完整的检索与 PV 选段逻辑，能力取决于你配置的资料。

需要 Node.js 24 或更新版本。桌面开发还需要 npm 安装 Electron 依赖。引擎使用 Node 内置 SQLite；无需下载数据库依赖。

```powershell
npm --prefix client ci
$env:AKASHA_ROOT = (Get-Location).Path
$env:KB_CLIENT_TOKEN = '自行生成并保存的独立随机令牌'
# 可选：自行准备的资料目录，里面放 kb.sqlite 和可选 kb-workspace.sqlite
$env:KB_DATA_DIR = Join-Path $env:AKASHA_ROOT 'data'
npm run desktop
```

首次启动没有资料时，聊天界面可打开并显示“未配置资料库”。鉴权的 `/v1/status` 返回 `ready:false`、`capabilities.corpus:false` 与配置指引；检索和聊天返回 HTTP 503、`corpus_not_configured`。这时不会调用模型，也不会伪装成“知识库没有某条资料”。未设置 `KB_CLIENT_TOKEN` 时资料接口保持锁定，没有免鉴权模式。

也可在两个终端分别执行 `npm run start:v1` 与 `npm run start:chat`，两者使用同一个自行设置的 `KB_CLIENT_TOKEN`。页面只能通过本地聊天服务的 `/v1` 代理访问引擎。

`AKASHA_ROOT` 决定桌面用户配置、临时文件、日志和媒体缓存所在位置。开发时默认仓库根；打包版默认用户应用数据目录。需要固定到其他磁盘时，在启动应用前设置该变量。打包版把用户数据写到用户应用数据目录；源码开发时写在仓库根下的 `userData/`、`temp/`、`logs/` 等目录。首次生成的 `userData/config.json` 提供 `kbDir`、`dataDir`、`videoIndexPath`、`voiceAudioDir`、`kbRemoteV1` 和 `kbRemoteV1Fallbacks`。令牌通过环境变量注入服务，避免提交用户配置。

### 准备语料

- 已有兼容资料库：通过 `KB_DATA_DIR` 指定目录；主库 `kb.sqlite` 必需。
- 有权使用的 Markdown：设置 `KB_SOURCE_DIR`，该目录结构为 `原神/*.md`、可选 `原神/书籍/*.md` 与 `立绘/原神/`，运行 `node engine/build.mjs`。
- 观测枢：设置 `OBC_SRC` 为本地采集目录、`KB_DATA_DIR` 为私有资料目录。运行 `node engine/tools/obc-sync-runner.mjs --ranges 1:50` 小范围测试；`--full` 检查已知条目详情，`--report` 查看状态。默认扫描范围可在代码常量或 `--ranges` 中修改，报告仅代表配置范围与已知 ID，不代表未知 ID 空间全覆盖。每批最多 50 个 ID、并发六个请求。请先确认相关来源及使用许可。首次运行会建立侧车索引表。

同步默认不会注册计划任务或访问网络，只有手动调用同步命令才会抓取。原来的定时同步算法完整保留；公开用户可按自己的配置调用脚本，参见 [配置说明](docs/CONFIGURATION.md)。

### 模型配置

默认连接本机 `http://127.0.0.1:8080/v1`，模型名为 `koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M`，API key 为空。请自行启动兼容 OpenAI 的模型服务；模型名需与服务实际提供的名称匹配。

`engine/chat/llm.config.example.json` 只含本地配置。复制为私有 `llm.config.json`，或用 `KB_LLM_CONFIG_PATH` 指定独立配置文件。`KB_LLM_BASE_URL`、`KB_LLM_MODEL`、`KB_LLM_API_KEY`、`KB_LLM_PROVIDER` 覆盖文件；`provider` 可选 `auto`、`openai`、`extractive`。`auto` 在模型不可达时返回真实资料摘录；如果没有语料，则仍提示先配置资料。

模型层只接受本机回环地址，云端模型、重定向和自动素材下载在此构建中被禁用，联网搜索未启用。远端知识库仅在显式配置 `kbRemoteV1` 时启用。若本机模型没有启动，仍可做本机检索和材料计算；回答会明确标为资料摘录。

### 观测枢侧车库（可选）

观测枢图鉴数据（`obc_*`）在侧车库中，是可选的。未导入时，角色、故事、语音、任务台词与书籍检索仍可正常工作；只是「武器 / 圣遗物 / 材料 / 食物 / 敌人」这类主库里没有的内容取不到，涉及这些的问题会如实说明没有相应资料。

### PV 私有索引（可选）

安装 ffmpeg / ffprobe 并加入 PATH，或配置 `FFMPEG_PATH`、`FFPROBE_PATH`。缺失时任务显示可读指引。

`KB_VIDEO_INDEX_PATH` 默认未设置。接口返回 `video_index_not_configured` 和“未配置视频索引”，不会崩溃。空格式见 `engine/video-index.example.json`。

从自行准备的观测枢侧车库生成私有来源索引：

```powershell
node engine/tools/build-video-index.mjs --output data/video-index.json
$env:KB_VIDEO_INDEX_PATH = Join-Path $env:KB_DATA_DIR 'video-index.json'
```

资料索引含来源信息，属于私有数据，禁止提交。本机构建的视频工作区只登记用户用桌面文件选择器选取的本机视频；原片仅在处理期间复制到本机临时缓存，结束后清理。片段使用鉴权的相对 `/v1/media/assets/...` 地址返回；缓存默认 2 GB，最多同时执行两个任务。

## 更新与构建

源码自建包默认不会连接远端知识库、模型或更新服务。安装包只包含客户端与通用程序资源；知识库、模型和用户工作区都留在本机。构建需要本机已有 Electron 运行时；构建脚本本身不安装依赖，`npm --prefix client ci` 与 electron-builder 仍可能联网获取依赖和工具链，完全离线时需预置 `client/node_modules` 并设置 `AKASHA_ELECTRON_DIST`。

```powershell
npm --prefix client ci
npm run build:client -- --version 0.5.10
```

构建结果写入独立的 `client/dist/release-0.5.10-*` 目录，不覆盖当前便携版。此版本不会检查更新或自动打开浏览器。`--version` 即发布版本号，构建时会同步写回根 `package.json`。

## 验证

```powershell
npm run check:secrets
npm test
```

默认测试无需游戏语料，包括空库引导、更新状态机、模拟同步和合成视频（媒体测试需 ffmpeg/ffprobe）。六项原有语料基线通过 `npm run test:baselines` 执行，需要显式设置自行准备的 `KB_DATA_DIR`；测试服务使用独立随机端口、独立测试令牌与较高限流配额，不读取生产令牌。测试日志放 `test-results/` 并被忽略。

原有 P0 空正文、P1 外号剧情、P2 结构化块与桌面功能测试保留在 `tests/`。其中语料/桌面完整功能测试需要自行配置的数据库、模型或测试 mock、视频私有索引；不属于无数据的默认测试。`tests/desktop-public-smoke.mjs` 可对独立开发或打包实例验证空语料界面与导航边界，通过 `AKASHA_SMOKE_EXE` 指定待测程序。

## 数据来源、致谢与授权

### 知识库与素材

官方桌面版通过 Akasha 官方知识库服务检索，知识库本体不随安装包分发；自建部署时，知识库、检索片段、模型与游戏素材由部署方在本机准备和管理。源码自建的引擎默认只接受本机回环的模型服务地址；问答和媒体处理不会自动联网搜索或下载素材。

### 第三方来源

| 来源 | 用途 | 授权状态 |
| --- | --- | --- |
| 原神 / 米哈游 / HoYoverse | 游戏文本与素材 | 待确认 |
| 米游社观测枢 | 官方公开资料接口、条目与 PV | 待确认 |
| 其它本地整理资料、图像、音频 | 自行部署时由部署方准备 | 待确认 |

本表为待核实的致谢与授权占位，不表示已获授权。第三方数据的权利和限制不会因本项目软件许可证而改变。依赖与许可证见 [第三方说明](docs/THIRD_PARTY.md)。

## 软件许可

本项目代码以 **AGPL-3.0-only** 发布，全文见 [LICENSE](LICENSE)。双授权意图：**商业闭源使用需另行授权**；商业用途遵守 AGPL 本身并不被一概禁止。另行商业授权的权利归属、贡献者协议和授权联系渠道仍须项目负责人确认。
