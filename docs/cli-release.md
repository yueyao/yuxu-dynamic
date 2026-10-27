# CLI npm 发布流程

CLI 以独立 npm 包发布；仓库根目录是私有开发包，不得直接发布。包名暂定为 `yuxu-platform-cli`，终端命令为 `yuxu`。首次发布前需确认该名称可注册；若名称被占用，修改 `apps/cli/package.json` 和发布工作流中对应的 tarball 名称。

## 包构建

`apps/cli/package.json` 是 npm 发布元数据的唯一来源。根目录的 `pack:cli` 先调用 `build:cli`：清理专用输出目录，再编译 CLI 和 `PlatformClient`，最后复制许可证；然后以 `--ignore-scripts` 打包，避免构建脚本进入发布包。包的 `files` 白名单仅包含这些编译文件、许可证和 CLI 专用 README；平台 API、Worker、测试和开发依赖均不进入 tarball。运行 CLI 只要求 Node.js 24 或更新版本。

本地生成并验证 tarball：

```sh
npm run pack:cli
npm run smoke:cli-package
```

smoke 测试会把生成的包安装到临时全局前缀，运行 `yuxu --help`，并验证配置命令可读写隔离目录。`.release/` 是临时产物，不应提交到 Git。

## 版本和发布

CLI 版本只在 `apps/cli/package.json` 维护。稳定版使用 SemVer；预发布版本带渠道后缀，例如 `0.1.0-next.0`。创建与版本完全一致的 Git tag：

```sh
git tag yuxu-cli-v0.1.0-next.0
git push origin yuxu-cli-v0.1.0-next.0
```

`.github/workflows/cli-release.yml` 在 PR、main 更新和发布 tag 上运行 Node.js 24 下的测试、类型检查、打包及隔离安装验证。发布 tag 必须与包版本一致。预发布版本发布到对应 npm dist-tag（如 `next`）；不带后缀的稳定版本发布到 `latest`。发布 job 使用已验证的 tarball，不在发布阶段重新构建。

npm 首次发布前的仓库配置：

1. 在 npm 上确认并创建 `yuxu-platform-cli` 包名；启用账户双重验证。
2. 在 npm 包设置中添加 GitHub Actions Trusted Publisher，仓库为 `yueyao/yuxu-dynamic`，workflow 为 `CLI package and release` 对应的 `.github/workflows/cli-release.yml`。
3. 在 GitHub 创建 `npm-production` environment，并设置所需审批人；发布 job 获批后通过 OIDC 获取短期发布授权。
4. 完成前三项并测试好发布权限后，再设置仓库变量 `YUXU_NPM_PUBLISH_ENABLED=true`。未设置该变量时，即使推送版本 tag，CI 仍会验证包但跳过发布。
5. 首次发布 `0.1.0-next.0` 后，从 npm registry 安装 `yuxu-platform-cli@next` 实机验证；确认后发布 `0.1.0`，将稳定版设为 `latest`。

不在仓库保存 npm token，也不手工覆盖已发布版本。发布错误通过增加版本号修复；不要依赖撤包作为回滚手段。
