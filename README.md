# yuxu-dynamic

当前有效工程：[Taskbase / Yuxun CLI](taskbase/README.md)。

## 目录

```text
taskbase/   任务平台、播客应用、Web、CLI、Mac Worker
spec/       需求文档
```

## 文档

- [Yuxun Web 使用文档](taskbase/docs/web.md)
- [Yuxun CLI 使用文档](taskbase/docs/cli.md)
- [Taskbase 文档导航](taskbase/docs/usage.md)
- [腾讯云部署](taskbase/docs/deploy-tencent.md)

## 旧代码

旧版 `apps/`、`packages/`、`deploy/funasr/` 等实现已从当前树移除。

- 历史与归档：`archive/pre-taskbase-20261106` 标签/分支
- 可迁移能力已进入 `taskbase/`：安全下载、Provider、切片检查点、FunASR 部署
- 遗留的时间任务、旧 CLI 发布流程属于废弃能力

这样做是为了让仓库只保留当前可运行的 Taskbase，而不是同时维护两套平台实现。
