# Akasha

Akasha 是原神知识检索客户端。本项目为粉丝非官方项目，与米哈游 / HoYoverse 无关联。当前源码构建的是 **0.5.0 本机工作台**：知识库、回答依据、工作计划和本地视频都留在本机。安装程序、云端服务和官方游戏资料均不包含在此源码中。

## 快速开始

先在本机准备有权使用的资料，并配置本机模型。没有资料或模型时，客户端会说明哪些本机功能仍可使用。此版本不自动连接 Releases，也不接受远端知识库或模型地址。

```powershell
npm ci
$env:KB_DATA_DIR = '本机资料库目录'
$env:KB_CLIENT_TOKEN = '自行生成的随机令牌'
npm run start:v1
```

另开终端，在同一项目目录启动 `npm run start:chat`，再访问 `http://127.0.0.1:5190`。如果使用源代码运行模型，配置 `engine/chat/llm.config.json` 指向本机兼容接口；密钥（若本机服务需要）只交给本机进程。

## 功能

- 实体与外号识别、多轮承接、复杂问题拆分检索、观测枢分类覆盖。
- 来源引用、检索依据检查和逐句引用审计；通过受限侧栏查看回答使用的本机资料片段。
- 档案、语音文本、关系、天赋、命座、培养材料、清单、时间线等结构化展示。
- 本机保存的考据专题、培养规划、材料库存、研究时间线与关系记录。
- 本机视频镜头索引、时间微调、原声预览与 H.264/AAC MP4 片段导出；最长 60 秒，不接受远端视频地址。
- 通过 `/v1` 使用鉴权的本机接口；用户数据存入独立 SQLite 文件，资料数据库以只读方式打开。

客户端只访问鉴权的 `/v1`。所有服务绑定 `127.0.0.1`。客户端窗口禁止外链、新窗口和知识库本体导航。

## 自己部署一套（可选）

桌面版只读取本机配置的资料目录，不随包分发资料或素材。所有本机界面请求经鉴权的 `/v1` 代理。

> **数据边界：** 本仓库**不包含任何游戏数据、观测枢正文、考据作品、图片、音频或视频**。
> 自行部署时，你需要自己准备有权使用的数据，并自行承担数据使用与分发的合规责任。
> 代码提供完整的检索与 PV 选段逻辑，能力取决于你配置的资料。

### 运行源码

需要 Node.js 24 或更新版本。桌面开发还需要 npm 安装 Electron 依赖。引擎使用 Node 内置 SQLite；无需下载数据库依赖。

```powershell
npm --prefix client ci
$env:AKASHA_ROOT = (Get-Location).Path
$env:KB_CLIENT_TOKEN = '自行生成并保存的独立随机令牌'
# 可选：自行准备的资料目录，里面放 kb.sqlite 和可选 kb-workspace.sqlite
$env:KB_DATA_DIR = Join-Path $env:AKASHA_ROOT 'data'
npm run desktop
```

首次启动没有资料时，聊天界面可打开并显示“未配置资料库”。鉴权的 `/v1/status` 返回 `ready:false`、`capabilities.corpus:false` 与配置指引；检索和聊天返回 HTTP 503、`corpus_not_configured`。这时不会调用模型，也不会伪装成“知识库没有某条资料”。未设置 `KB_CLIENT_TOKEN` 时资料接口保持锁定，没有内置令牌或免鉴权模式。

也可在两个终端分别执行 `npm run start:v1` 与 `npm run start:chat`，两者使用同一个自行设置的 `KB_CLIENT_TOKEN`。页面只能通过本地聊天服务的 `/v1` 代理访问引擎。

`AKASHA_ROOT` 决定桌面用户配置、临时文件、日志和媒体缓存所在位置。开发时默认仓库根；打包版默认用户应用数据目录。需要固定到其他磁盘时，在启动应用前设置该变量。源码和安装目录不会被当成可写用户目录。首次生成的 `userData/config.json` 提供 `kbDir`（引擎覆盖）、`dataDir`、`videoIndexPath`、`kbRemoteV1` 和 `kbRemoteV1Fallbacks`。令牌通过环境变量注入服务，避免提交用户配置。

### 准备语料

- 已有兼容资料库：通过 `KB_DATA_DIR` 指定目录；主库 `kb.sqlite` 必需。
- 有权使用的 Markdown：设置 `KB_SOURCE_DIR`，该目录结构为 `原神/*.md`、可选 `原神/书籍/*.md` 与 `立绘/原神/`，运行 `node engine/build.mjs`。
- 观测枢：设置 `OBC_SRC` 为本地采集目录、`KB_DATA_DIR` 为私有资料目录。运行 `node engine/tools/obc-sync-runner.mjs --ranges 1:50` 小范围测试；`--full` 检查已知条目详情，`--report` 查看状态。默认扫描范围可在代码常量或 `--ranges` 中修改，报告仅代表配置范围与已知 ID，不代表未知 ID 空间全覆盖。每批最多 50 个 ID、并发六个请求。请先确认相关来源及使用许可。首次运行会建立侧车索引表。

同步默认不会注册计划任务或访问网络，只有手动调用同步命令才会抓取。原来的定时同步算法完整保留；公开用户可按自己的配置调用脚本，参见 [配置说明](docs/CONFIGURATION.md)。

### 模型配置

默认连接本机 `http://127.0.0.1:8080/v1`，模型名为 `koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M`，API key 为空。请自行启动兼容 OpenAI 的模型服务；模型名需与服务实际提供的名称匹配。

`engine/chat/llm.config.example.json` 只含本地配置。复制为私有 `llm.config.json`，或用 `KB_LLM_CONFIG_PATH` 指定独立配置文件。`KB_LLM_BASE_URL`、`KB_LLM_MODEL`、`KB_LLM_API_KEY`、`KB_LLM_PROVIDER` 覆盖文件；`provider` 可选 `auto`、`openai`、`extractive`。`auto` 在模型不可达时返回真实资料摘录；如果没有语料，则仍提示先配置资料。

模型层只接受本机回环地址。云端模型、远端 KB、联网搜索、重定向和自动素材下载均在此构建中禁用。若本机模型没有启动，仍可做本机检索和材料计算；回答会明确标为资料摘录。

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

本地版不会连接远端知识库、模型或更新服务。`0.5.0` 的安装包只包含客户端与通用程序资源；知识库、模型和用户工作区都留在本机。构建需要本机已有 Electron 运行时，构建期间不自动下载依赖。

```powershell
npm --prefix client ci
npm run build:client -- --version 0.5.0
```

构建结果写入独立的 `client/dist/release-0.5.0-*` 目录，不覆盖当前便携版。此版本不会检查更新或自动打开浏览器。

## 验证

```powershell
npm run check:secrets
npm test
```

默认测试无需游戏语料，包括空库引导、更新状态机、模拟同步和合成视频（媒体测试需 ffmpeg/ffprobe）。六项原有语料基线通过 `npm run test:baselines` 执行，需要显式设置自行准备的 `KB_DATA_DIR`；测试服务使用独立随机端口、独立测试令牌与较高限流配额，不读取生产令牌。测试日志放 `test-results/` 并被忽略。

原有 P0 空正文、P1 外号剧情、P2 结构化块与桌面功能测试保留在 `tests/`。其中语料/桌面完整功能测试需要自行配置的数据库、模型或测试 mock、视频私有索引；不属于无数据的默认测试。`tests/desktop-public-smoke.mjs` 可对独立开发或打包实例验证空语料界面与导航边界，通过 `AKASHA_SMOKE_EXE` 指定待测程序。

## 数据来源、致谢与授权

### 本地资料与素材

知识库、检索片段、模型与游戏素材由用户在本机准备和管理，不包含在安装包中。本机版拒绝非回环网络服务地址；问答和媒体处理不会自动联网搜索或下载素材。

### 第三方来源

| 来源 | 用途 | 授权状态 |
| --- | --- | --- |
| 原神 / 米哈游 / HoYoverse | 游戏文本与素材 | 待确认 |
| 米游社观测枢 | 官方公开资料接口、条目与 PV | 待确认 |
| 其它本地整理资料、图像、音频 | 自行部署时由部署方准备 | 待确认 |

本表为待核实的致谢与授权占位，不表示已获授权。第三方数据的权利和限制不会因本项目软件许可证而改变。依赖与许可证见 [第三方说明](docs/THIRD_PARTY.md)。

## 软件许可

本项目代码以 **AGPL-3.0-only** 发布，全文见 [LICENSE](LICENSE)。双授权意图：**商业闭源使用需另行授权**；商业用途遵守 AGPL 本身并不被一概禁止。另行商业授权的权利归属、贡献者协议和授权联系渠道仍须项目负责人确认。
