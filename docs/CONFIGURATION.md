# 配置

| 配置 | 用途 | 默认 |
| --- | --- | --- |
| `AKASHA_ROOT` | 桌面运行目录、用户配置、日志、临时文件和缓存 | 开发仓库根 / 打包用户应用数据目录 |
| `KB_DATA_DIR` | 私有主库及侧车库目录 | 引擎 `data/`；桌面运行根 `data/` |
| `KB_CLIENT_TOKEN` | `/v1` 鉴权；引擎和聊天代理共用 | 空，资料接口锁定 |
| `KB_CLIENT_PORT` | 独立引擎端口 | 5180 |
| `AKASHA_V1_PORT` / `AKASHA_TEST_CHAT_PORT` | 桌面启动的服务端口 | 5180 / 5190 |
| `AKASHA_TEST_USER_DATA` / `DESKTOP_DEBUG_PORT` | 隔离测试的用户目录 / 调试端口 | 不启用 |
| `KB_SOURCE_DIR` | 主库 Markdown 输入目录 | 运行根 `data-src/` |
| `OBC_SRC` / `OBC_DB` | 同步的私有原始 JSON 目录 / 侧车库文件 | 运行根 `data-src/hoyowiki` / `KB_DATA_DIR/kb-workspace.sqlite` |
| `KB_LLM_CONFIG_PATH` | 用户模型配置文件 | 引擎 `chat/llm.config.json`；桌面用户目录 `llm.config.json` |
| `KB_LLM_BASE_URL` / `KB_LLM_MODEL` / `KB_LLM_API_KEY` / `KB_LLM_PROVIDER` | 模型配置覆盖 | 本地模型；key 空 |
| `KB_VIDEO_INDEX_PATH` | 私有视频索引文件 | 空，视频功能明确提示未配置 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 视频处理程序 | PATH 的 ffmpeg / ffprobe |
| `KB_MEDIA_CACHE` | 镜头、缩略图、片段缓存 | 引擎数据目录 `media-cache/` |

所有服务固定绑定回环，公开代码不支持免鉴权开关。用户不要把真实令牌、云端地址或个人目录写进仓库 example。

Windows 定时同步可使用任务计划程序创建“北京时间每日 03:00”与“每周日 04:00”的任务，工作目录设置为自行选择的项目根，分别调用 `node engine/tools/obc-sync-runner.mjs` 与带 `--full` 的命令。任务运行账户需读取私有配置并具备数据目录权限。公开构建不会自动创建或修改系统任务。
