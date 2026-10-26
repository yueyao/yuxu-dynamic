# 项目协作说明

## 当前状态

- `docs/index.md` 是总体方案，`docs/detailed-design.md` 是建议的实现基线，`docs/implementation-plan.md` 记录当前 MVP 范围和后续路径，`docs/modules.md` 说明现有模块，`docs/time-query-flow.md` 记录当前时间查询目标。
- 本地 MVP 已实现。运行命令与已完成能力以根目录 `README.md` 和 `package.json` 为准。
- `docs/` 存放现有方案和后续设计记录。

## 项目目标

构建一个供多个独立应用使用的共享平台。平台提供身份与权限、任务运行、产物存储和基础数据服务；各应用保留自己的页面、API 和业务逻辑。CLI 是第一版的主要本地客户端。具体范围和阶段划分以 `docs/index.md` 为准。

## 开发约定

- 开始实现前先阅读 `docs/index.md`、`docs/detailed-design.md`、`docs/implementation-plan.md` 和 `docs/modules.md`，按当前阶段推进。
- 当前代码使用 TypeScript 与 Node.js 内置模块；后续框架、数据库和云产品的选择以实施阶段的决策为准，不要把详细设计中的建议误写成已实现能力。
- 平台与应用之间保持语言无关的 HTTP/JSON 接口；应用的领域逻辑留在应用内。
- 任务设计需考虑持久化、进度与日志、超时、取消、重试、Worker 中断恢复、幂等和版本追踪。分阶段实现时明确已支持的能力。
- 不要在首版加入 `docs/index.md` 第 8 节列出的暂缓功能，除非需求明确改变。
- 新增可运行代码时，同时补充实际可用的启动方式、配置说明和针对关键行为的验证方式；不要记录尚未执行过的测试结果。

## 文档维护

- 架构或实施范围变化时，更新 `docs/index.md` 或在 `docs/` 中记录决策，并保持两者一致。
- 使用中文说明项目约定；代码标识符、协议字段和命令保持其原有语言。
