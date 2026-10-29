# CLI npm 发布流程

CLI 以独立 npm 包 `yuxu-dynamic-cli` 发布；仓库根目录是私有开发包，不得直接发布。终端命令为 `yuxu`。首次发布前仍需确认该名称可注册。

## 发布前检查

发布前从干净工作区执行完整验证：

```sh
npm ci
npm test
npm run typecheck
npm run pack:cli
npm run smoke:cli-package
```

当前 `0.1.0-next.0` 应生成 `.release/yuxu-dynamic-cli-0.1.0-next.0.tgz`。如果本机 npm 缓存存在历史权限问题，可只在本机验证时使用临时缓存：

```sh
npm_config_cache=/private/tmp/yuxu-npm-cache npm run pack:cli
npm_config_cache=/private/tmp/yuxu-npm-cache npm run smoke:cli-package
```

临时缓存设置不需要写入项目脚本或 GitHub Actions。

## 包构建

`apps/cli/package.json` 是 npm 发布元数据的唯一来源。根目录的 `pack:cli` 先调用 `build:cli`：清理专用输出目录，再编译 CLI 和 `PlatformClient`，最后复制许可证；然后以 `--ignore-scripts` 打包，避免构建脚本进入发布包。包的 `files` 白名单仅包含这些编译文件、许可证和 CLI 专用 README；平台 API、Worker、测试和开发依赖均不进入 tarball。运行 CLI 只要求 Node.js 24 或更新版本。

本地生成并验证 tarball：

```sh
npm run pack:cli
npm run smoke:cli-package
```

smoke 测试会把生成的包安装到临时全局前缀，运行 `yuxu --help`，并验证配置命令可读写隔离目录。`.release/` 是临时产物，不应提交到 Git。

## 版本和发布

CLI 版本只在 `apps/cli/package.json` 维护。稳定版使用 SemVer；预发布版本带渠道后缀，例如 `0.1.0-next.0`。先把版本及相关文档提交到 `main` 并推送，再创建与版本完全一致的 annotated Git tag：

```sh
git tag -a yuxu-cli-v0.1.0-next.0 \
  -m "Release yuxu-dynamic-cli 0.1.0-next.0"
git push origin yuxu-cli-v0.1.0-next.0
```

`.github/workflows/cli-release.yml` 在 PR、main 更新和发布 tag 上运行 Node.js 24 下的测试、类型检查、打包及隔离安装验证。发布 tag 必须与包版本一致。预发布版本发布到对应 npm dist-tag（如 `next`）；不带后缀的稳定版本发布到 `latest`。发布 job 使用已验证的 tarball，不在发布阶段重新构建。

## npm 与 GitHub 配置

1. 在 npm 上确认 `yuxu-dynamic-cli` 包名，发布账号启用双重验证。
2. 在 GitHub 仓库的 `Settings → Environments` 创建 `npm-production` environment，并按需设置 Required reviewers。
3. 在 npm 包设置中添加 GitHub Actions Trusted Publisher：所有者为 `yueyao`，仓库为 `yuxu-dynamic`，workflow 文件为 `cli-release.yml`，environment 为 `npm-production`。
4. 在 GitHub 的 `Settings → Secrets and variables → Actions → Variables` 新建仓库变量 `YUXU_NPM_PUBLISH_ENABLED=true`。

发布工作流已声明 `id-token: write`，通过 npm OIDC 获取短期发布授权。不要在仓库或 GitHub Secrets 中保存长期 npm token。未设置 `YUXU_NPM_PUBLISH_ENABLED=true` 时，推送发布 tag 仍会完成测试、打包和 artifact 上传，但会跳过 npm publish。

## 首次发布引导

优先在 npm 上为包配置 Trusted Publisher，然后使用 Git tag 触发自动发布。如果 npm 不允许尚未发布的包进入设置页或配置 Trusted Publisher，则首次发布需要人工引导：

1. 保持 `YUXU_NPM_PUBLISH_ENABLED` 未设置或不为 `true`，避免 CI 重复发布同一版本。
2. 完成本地验证并创建对应源码 tag，但暂不依赖 CI 发布。
3. 使用发布账号登录 npm，并发布已经验证的 tarball：

   ```sh
   npm login
   npm publish .release/yuxu-dynamic-cli-0.1.0-next.0.tgz \
     --access public \
     --tag next
   ```

4. 推送源码 tag，让 GitHub Actions 对该提交执行同一套验证；因为发布开关关闭，工作流不会重复调用 npm publish。
5. 包创建后，在 npm 中配置 Trusted Publisher，再创建 GitHub `npm-production` environment 并开启 `YUXU_NPM_PUBLISH_ENABLED=true`。
6. 下一次自动发布必须把版本增加到新的 SemVer，例如 `0.1.0-next.1`；npm 不允许覆盖已经发布的 `0.1.0-next.0`。

手工引导仅用于创建首个包版本。后续版本统一通过 GitHub Actions 发布，避免本机凭据成为长期发布路径。

## 触发自动发布

确认 npm Trusted Publisher、GitHub environment 和发布变量都已配置后，推送与 `apps/cli/package.json` 版本完全一致的 tag：

```sh
git push origin main
git tag -a yuxu-cli-v0.1.0-next.0 \
  -m "Release yuxu-dynamic-cli 0.1.0-next.0"
git push origin yuxu-cli-v0.1.0-next.0
```

工作流会依次运行测试、类型检查、tag/版本校验、打包和隔离安装验证，然后上传 tarball。`publish` job 会等待 `npm-production` 的审批，并把预发布版本发布到由版本后缀决定的 dist-tag；`0.1.0-next.0` 对应 `next`，不带预发布后缀的稳定版本对应 `latest`。

## 发布后验证

在 registry 确认版本和 dist-tag，然后从 npm 完成一次全局安装：

```sh
npm view yuxu-dynamic-cli@next version
npm install --global yuxu-dynamic-cli@next
yuxu --help
```

首次发布 `0.1.0-next.0` 后，应看到版本 `0.1.0-next.0`。完成实际使用验证后再发布 `0.1.0`，并将稳定版设为 `latest`。

不手工覆盖已发布版本。发布错误通过增加版本号修复；不要依赖撤包作为回滚手段。
