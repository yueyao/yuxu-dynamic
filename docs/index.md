# 共享应用平台总体方案

详细的技术选择、接口、数据模型与阶段验收见 [详细设计](./detailed-design.md)；CLI 产品边界和开发路径见 [个人 CLI 设计](./personal-cli-design.md)；客户端、平台与服务端 Worker 的职责边界见 [服务端任务设计](./server-task-design.md)，播客场景的长期需求见 [播客转写 Task 需求](./podcast-transcription-task.md)，来源解析、转写引擎比较和首版选型见 [播客转写技术调研](./podcast-transcription-research.md)；实际落地顺序见 [实现路径](./implementation-plan.md)；已实现代码的职责和调用关系见 [模块说明](./modules.md)。当前通用任务接口见 [任务底座调用与状态契约](./task-platform-flow.md)，时间查询验证用例见 [时间查询闭环](./time-query-flow.md)。

## 1. 总体结构

CLI / 独立 Web 应用 / 管理台
              ↓
        共享平台 API
              ↓
 ┌────────────┼────────────┐
身份认证    任务运行      数据与产物
              ↓
      队列 + 独立 Worker

共享底座负责通用能力，具体应用负责自己的业务逻辑和页面。

### 任务职责边界

- CLI 和 Web 应用只收集任务基本数据和资源定位信息、提交任务并展示状态与结果；本地文件类任务才需要额外上传。
- 共享平台是任务控制面，统一处理认证、schema、队列、租约、恢复、进度、日志和资源授权。
- 领域任务由服务端应用 Worker 实现；转码、模型调用和业务计算不放入 CLI、浏览器或平台 API。
- 客户端提交小体积 JSON，其中可以包含网页 URL、供应商内容 ID 或平台资产 ID；不上传脚本，也不把音频、图片等大文件塞进 JSON。
- Worker 与应用版本绑定并独立部署；服务端更换处理引擎通常不要求升级 CLI。

这一边界适用于播客转写、图片生成、报告构建和数据导入等任务。平台不为每种业务增加专用执行路由，而是让应用 Worker 通过统一任务协议接入。

## 2. 共享底座能力

### 身份与访问

- 单用户账号登录
- Web 会话
- CLI Token
- 应用、任务、数据资源、产物的权限控制
- webhook 签名验证
- 日志和审计记录

首版使用密码登录，密码由成熟认证库处理；未来可以扩展 OIDC 或 Passkey。

### 任务运行

每个应用可以注册多个任务，例如：

image/generate
article/summarize
data/import
report/build

任务流程：

提交任务
  → 创建任务记录
  → 进入持久化队列
  → Worker 执行
  → 更新进度和日志
  → 保存结果和产物
  → 返回任务状态

任务支持：

- 手动 API/CLI 触发
- 定时触发
- webhook 触发
- 进度报告
- 日志记录
- 超时
- 取消
- 重试
- Worker 中断恢复
- 幂等键
- 任务版本追踪

任务状态大致为：

queued → running → succeeded
                  ├→ failed
                  ├→ cancelling → cancelled
                  └→ recovering

首版只执行已经部署的任务插件，不支持用户上传任意脚本并运行。

### 产物服务

图片、文件、报告等结果保存到对象存储。

数据库保存：

- 任务输入摘要
- 任务状态
- 执行日志
- 步骤状态
- 产物引用
- 创建时间和完成时间
- 执行版本

这样可以长期追溯任务历史，而不是只返回一次性结果。

### 通用数据服务

平台提供简单的声明式数据资源和 CRUD API。

应用可以声明：

资源：notes
字段：
- title: string
- content: text
- status: enum
- created_at: datetime

平台负责：

- 建表
- 迁移
- 基础 CRUD
- 分页
- 筛选
- 排序
- 基础权限

应用仍负责：

- 复杂业务规则
- 复杂查询
- 跨资源事务
- 领域逻辑
- 自定义页面

不建设低代码页面编辑器。页面仍由每个应用独立开发。

## 3. 应用模型

每个应用独立拥有：

- 前端页面
- API 路由
- 业务代码
- 任务定义
- Worker
- 数据资源声明
- 应用版本
- 部署流程

例如：

apps/
  image-lab/
  reading-assistant/
  finance-tools/
  personal-dashboard/

应用通过语言无关的 HTTP/JSON 协议连接平台，首版提供 TypeScript SDK。

应用声明：

- 应用 ID
- 应用版本
- 任务列表
- 输入输出结构
- Worker 启动方式
- 数据资源
- 所需权限
- 产物类型

应用之间默认不直接编排，避免共享底座变成复杂的大单体。

## 4. CLI 设计

CLI 是第一版主要本地客户端。

示例：

yuxu login

yuxu apps list
yuxu tasks list

yuxu task run image-lab/generate \
  --input prompt.json

yuxu task get <task-id>
yuxu task watch <task-id>
yuxu task cancel <task-id>
yuxu task retry <task-id>

yuxu artifact download <artifact-id>

platform schedule list
platform data get reading-assistant/notes

CLI 负责：

- 登录
- 任务发现
- 提交任务
- 查看进度
- 读取日志
- 取消和重试
- 上传输入文件
- 下载结果
- 操作定时任务
- 操作通用数据资源

CLI 不负责执行具体任务算法。Web 应用遵循同一边界：页面负责表单和展示，并按任务需要提交链接、内容 ID 或已上传资产 ID；应用后端使用用户 API 提交任务，核心处理在服务器侧 Worker 中完成。

暂不开发桌面 GUI。只有出现本地文件监听、系统通知、本地软件调用等需求时，再在 CLI 之上增加桌面客户端。

## 5. Web 应用与管理台

### 独立 Web 应用

每个应用有自己的页面和业务体验，例如：

- 图片生成工作台
- 阅读资料管理器
- 财务数据分析工具
- 个人知识库
- 报告生成器

这些应用调用共享平台 API，但不依赖其他应用的数据库表。

### 管理台

管理台只负责平台运维：

- 查看所有任务
- 查看任务详情
- 查看步骤和日志
- 查看 Worker 状态
- 查看失败原因
- 手动重试
- 管理定时任务
- 管理 webhook
- 管理产物
- 管理声明式数据资源

管理台不承担各应用的业务页面。

## 6. 推荐技术方向

首选 TypeScript，原因是：

- 平台 API、CLI、SDK 可以共享类型
- 任务输入输出容易使用 schema 校验
- Web 应用和管理台技术栈统一
- 便于构建单一 monorepo

逻辑组件包括：

platform-api
task-runtime
worker-sdk
scheduler
artifact-service
data-service
admin-console
cli
application packages

底层基础设施包括：

- 关系型数据库
- 持久化任务队列
- 对象存储
- 日志和监控
- 自动备份
- Git 驱动的应用发布

具体云厂商和部署产品暂不锁定。

## 7. 实施顺序

### 第一阶段：任务闭环

先实现：

- 登录
- 平台 API
- 任务注册
- 任务提交
- 队列
- Worker
- 任务状态
- 产物上传
- CLI
- 一个示例应用

验收标准：能从 CLI 提交一个较长任务，查看进度，Worker 重启后恢复，并下载结果。

### 第二阶段：管理能力

增加：

- 管理台
- 周期性定时任务（单次计划执行已可用）
- webhook
- 取消
- 重试
- 日志查看
- 审计记录

### 第三阶段：数据服务

增加：

- 声明式资源
- 自动迁移
- CRUD API
- 分页和筛选
- 应用级权限

### 第四阶段：多应用发布

增加：

- 应用注册
- 应用版本
- Worker 健康检查
- Git 自动部署
- 任务版本绑定
- 独立应用发布和回滚

## 8. 暂不实现的内容

首版不做：

- 任意代码上传执行
- 跨应用工作流引擎
- 低代码页面编辑器
- 多租户和计费
- 自托管 GPU 模型
- 桌面 GUI
- 自研分布式调度系统
- 复杂 BI 和全文搜索
- 跨应用事务

核心原则是：平台只抽象真正重复的能力，具体业务保留在独立应用中。
