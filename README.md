# Akasha

Akasha 是原神知识检索客户端。本项目为粉丝非官方项目，与米哈游 / HoYoverse 无关联。

## 快速开始

**下载安装包，打开就能用。不需要准备数据，不需要装模型，不需要填任何地址或密钥。**

到 [Releases](https://github.com/kevin-ninoho/Akasha-genshin/releases) 下载 `Akasha-*-安装版.exe`（或便携版），双击打开，输入问题即可。客户端会连上已部署好的知识库服务，得到带**逐句出处引用**的回答。

- 回答里的**引用标签不可点击** —— 客户端只能停在对话界面，看不到知识库本体。
- 检索与生成都在服务端完成，客户端本地不落地任何知识库数据。
- 模型 API key 只存在于服务端，**永远不会下发到客户端**。

## 功能

- 实体与外号识别、多轮承接、复杂问题拆分检索、观测枢分类覆盖。
- 来源引用、检索依据检查、逐句引用审计、正文/思考流式展示；引用标签不可跳转。
- 档案、语音文本、关系、天赋、命座、培养材料、清单、时间线等结构化展示。
- 观测枢增量发现、详情版本检查、断点恢复、互斥锁、事务更新与检索缓存刷新。
- PV 镜头索引、中点缩略图、连续起止镜头选择、时间微调、原声预览与 H.264/AAC MP4 片段导出；最长 60 秒，不支持整段导出。
- 安装版 GitHub Releases 更新；便携版查询版本并提供可复制发布页地址。

客户端只访问鉴权的 `/v1`。所有服务绑定 `127.0.0.1`。客户端窗口禁止外链、新窗口和知识库本体导航。

## 自己部署一套（可选）

上面的安装包连的是本项目预部署好的服务。如果你想把整套跑在自己机器上 —— 用自己的数据、自己的模型、自己的 key —— 下面是完整说明。

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

本地小模型适合离线使用，复杂因果解释和引用稳定性取决于模型能力。云端模型可按需配置兼容地址与 key；没有默认云服务、付费服务地址或商业令牌。云端 KB 模式由用户在 `config.json` 显式填写 `kbRemoteV1`（以 `/v1` 结尾）及可选备选地址，客户端不启动本地引擎。HTTPS 代理保持可用。模型 key 在引擎进程中使用，不发送到聊天前端。

### 剧情线资料（可选）

`storyDb` 和观测枢侧车库是可选的。未导入剧情线考据时，角色、任务台词和其它检索仍可工作，状态包含 `storylineAvailable:false`。设定与剧情考据问题明确说明当前未配置剧情线考据资料，随后仅依据已配置资料回答。

缺少该资料会失去对应作品的深层考据、时间线与因果链问答能力。仓库没有《日月全事》正文或任何副本。

### PV 私有索引（可选）

安装 ffmpeg / ffprobe 并加入 PATH，或配置 `FFMPEG_PATH`、`FFPROBE_PATH`。缺失时任务显示可读指引。

`KB_VIDEO_INDEX_PATH` 默认未设置。接口返回 `video_index_not_configured` 和“未配置视频索引”，不会崩溃。空格式见 `engine/video-index.example.json`。

从自行准备的观测枢侧车库生成私有来源索引：

```powershell
node engine/tools/build-video-index.mjs --output data/video-index.json
$env:KB_VIDEO_INDEX_PATH = Join-Path $env:KB_DATA_DIR 'video-index.json'
```

索引含来源 URL，属于私有数据，禁止提交。客户端只发送条目 ID、视频序号与起止时间；服务端解析来源并仅返回鉴权的相对 `/v1/media/assets/...` 片段/缩略图 URL。整段源文件只在任务期间作临时处理，结束后清理；缓存默认 2 GB，最多同时执行两个任务，按最近使用时间淘汰。

## 更新与构建

发布版本只在根 `package.json` 中维护；构建命令必须明确提供版本。安装包、应用元数据和 `latest.yml` 使用该版本。GitHub owner/repo 从构建环境注入到包内，普通用户配置不能修改更新源。

```powershell
$env:AKASHA_GITHUB_OWNER = '你的GitHub账号'
$env:AKASHA_GITHUB_REPO = '你的仓库名'
npm run build:client -- --version 0.3.0
```

未设置 owner/repo 时，“关于”显示此构建未配置 GitHub Releases，更新功能禁用。开发环境不检查更新。安装版启动后延迟检查、后台下载，下载完由用户选择“重启并更新”；退出应用不会自动安装。便携版只查询版本，不下载或替换应用。应用不会自动打开浏览器。

构建脚本仅产出本地 NSIS、便携 EXE、`.blockmap`、`latest.yml` 和校验文件，始终使用 `--publish never`。首次发布与更新发布须由人执行，参见 [发布说明](docs/RELEASING.md)。

## 验证

```powershell
npm run check:secrets
npm test
```

默认测试无需游戏语料，包括空库引导、更新状态机、模拟同步和合成视频（媒体测试需 ffmpeg/ffprobe）。六项原有语料基线通过 `npm run test:baselines` 执行，需要显式设置自行准备的 `KB_DATA_DIR`；测试服务使用独立随机端口、独立测试令牌与较高限流配额，不读取生产令牌。测试日志放 `test-results/` 并被忽略。

原有 P0 空正文、P1 外号剧情、P2 结构化块与桌面功能测试保留在 `tests/`。其中语料/桌面完整功能测试需要自行配置的数据库、模型或测试 mock、视频私有索引；不属于无数据的默认测试。`tests/desktop-public-smoke.mjs` 可对独立开发或打包实例验证空语料界面与导航边界，通过 `AKASHA_SMOKE_EXE` 指定待测程序。

## 数据来源、致谢与授权

### 预部署服务

[Releases](https://github.com/kevin-ninoho/Akasha-genshin/releases) 里的安装包默认连到本项目作者部署的知识库服务，数据由作者维护。该服务的模型 API key 保存在服务端，不下发、不内置于客户端。

### 第三方来源

| 来源 | 用途 | 授权状态 |
| --- | --- | --- |
| 原神 / 米哈游 / HoYoverse | 游戏文本与素材 | 待确认 |
| 米游社观测枢 | 官方公开资料接口、条目与 PV | 待确认 |
| 诗漱《日月全事》 | 可选剧情线考据，需署名与另行确认使用条件 | 待确认 |
| 其它本地整理资料、图像、音频 | 自行部署时由部署方准备 | 待确认 |

本表为待核实的致谢与授权占位，不表示已获授权。第三方数据的权利和限制不会因本项目软件许可证而改变。依赖与许可证见 [第三方说明](docs/THIRD_PARTY.md)。

## 软件许可

本项目代码以 **AGPL-3.0-only** 发布，全文见 [LICENSE](LICENSE)。双授权意图：**商业闭源使用需另行授权**；商业用途遵守 AGPL 本身并不被一概禁止。另行商业授权的权利归属、贡献者协议和授权联系渠道仍须项目负责人确认。
