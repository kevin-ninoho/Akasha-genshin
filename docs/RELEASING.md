# 人工发布

仓库准备与构建不会创建 GitHub 仓库、配置 remote、执行 push 或创建 Release。本文件只提供由人审核执行的模板。

## 两种包，不要混用

|  | 官方分发包 | 源码自建包 |
| --- | --- | --- |
| 构建位置 | 部署方自己的私有分支 | 任意位置，含本仓库 CI |
| 是否内置服务地址与令牌 | **是**，写在客户端构建默认值里 | **否** |
| 用户打开后 | 直接连上部署方的知识库，开箱即用 | 显示「未配置资料库」引导，需自备语料与模型 |
| 用途 | 发给普通用户 | 验证构建可复现、自行部署 |

本仓库的 CI（`.github/workflows/build.yml`）产出的是**源码自建包**。它不含任何服务地址、令牌或语料，产物只用于验证构建可复现，**不能当官方分发包发给用户**。

面向普通用户的官方分发包由部署方在自己一侧构建，构建时把服务地址与令牌写入客户端默认配置。**那份构建配置不进入本仓库**，也不要把任何含地址或令牌的产物提交上来。

## 步骤

1. 轮换已泄漏的模型 key 与客户端令牌，确认代码及数据来源许可，确认贡献者对商业授权的权利。
2. 人工创建空 GitHub 仓库。检查待提交文件与 `npm run check:secrets` 结果；不要提交 `data/`、真实配置、私有视频索引或测试结果。
3. 设置构建环境 `AKASHA_GITHUB_OWNER`、`AKASHA_GITHUB_REPO`。版本使用明确的稳定三段式，例如 `0.3.0`。
4. 如需可信的 Windows 安装和更新，配置代码签名证书与 `CSC_LINK`、`CSC_KEY_PASSWORD`。签名凭证须放安全存储；未配置时产物为未签名验收包。GitHub Actions 的签名/访问凭证须由仓库负责人配置。
5. 执行 `npm --prefix client ci` 和 `npm run build:client -- --version 0.3.0`。环境变量 `AKASHA_BUILD_DIR` 可指定独立输出目录；`AKASHA_ELECTRON_DIST` 可复用已安装的同版本 Electron 运行时。检查 EXE、NSIS `.blockmap`、`latest.yml`、SHA256SUMS；`latest.yml` 必须指向 NSIS 安装包，不能指向便携包。
6. 首次推送由人执行。人工审核过的命令模板如下，**不要将其纳入自动脚本**：

```text
git add <已审核的源码路径>
git commit -m "Prepare public Akasha source"
git remote add origin <人工创建的仓库地址>
git push -u origin main
```

7. 在 GitHub Releases 人工创建 `v0.3.0` 的非草稿稳定 Release，并上传安装包、对应 `.blockmap`、`latest.yml` 与便携包。也可在确认权限后手动运行命令模板：

```text
gh release create v0.3.0 <安装包路径> <对应.blockmap路径> <latest.yml路径> <便携包路径> --repo OWNER/REPO --title "Akasha 0.3.0"
```

不向发布命令传入语料或整个构建目录。后续发布只需提高版本并上传新产物，已安装的支持更新版本会检测并后台下载；首次升级到支持更新的版本仍需要用户安装一次。无法联网、发布页不存在或缺少元数据时应显示检查失败，不能宣称升级成功。

内存受限时可设置 `AKASHA_BUILD_COMPRESSION=store`，降低压缩阶段内存占用；产物会更大。保持每次构建的独立输出目录。

项目 `.github/workflows/build.yml` 仅手动构建、运行不依赖版权语料的测试并保存 Actions 工件；不自动发布 Release，不推送源码。真实 GitHub 更新下载、签名校验和用户安装升级须在人工建立真实发布源后验收。
