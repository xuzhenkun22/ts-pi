# Pi 任务面板

HTTP 接收任务并写入 MySQL；后台用本地 Redis / BullMQ 调度，由 Pi CLI RPC 执行。MySQL 是任务状态的最终依据。

## 本地启动（Windows / Linux）

需要 Node.js 22.22+、MySQL 8 和 Redis 6.2+。本地 Redis 默认 `redis://127.0.0.1:6379`，不需要密码。

1. `npm ci`。复制 `.env.example` 为 `.env`（已有 `.env` 时补齐字段，不要覆盖密钥）。在 MySQL 创建 `pi_tasks` 数据库和账号，填写 `MYSQL_*`，运行 `npm run db:migrate`。部署时可用独立迁移账号运行建表，运行账号只需业务表的查询和写入权限。
2. 复制 `config/pi-models.example.json` 中的 `relay` 配置到 Pi 配置目录的 `models.json`（已有其他模型时合并，不要覆盖）。默认目录是 `~/.pi/agent`，也可以用 `PI_CODING_AGENT_DIR` 指定。填写真实中转站 `baseUrl`（例如 `https://example.com/v1`）；若使用 `/responses`，将 `api` 改成 `openai-responses`。将密钥填写到 `.env` 的 `RELAY_API_KEY`，不写进模型配置文件。
3. 两个终端分别运行 `npm run dev` 和 `npm run worker`。打开 <http://127.0.0.1:3000>，或使用 [tasks.http](tasks.http) 提交示例。启用 HTTP 鉴权时，为 `.http` 请求添加 Basic Authorization（不要提交密钥）。

## 工作区和执行

`.env` 中的 `WORKSPACE_ROOT` 是所有任务目录的上一级，部署时应预先创建并给 API、Worker 相应权限。界面分为「上传资料」「查看执行」「核对结果」三步。选择一个或多个文件、填写任务描述并提交后，API 自动生成 UUID，将文件写入 `<WORKSPACE_ROOT>/<UUID>/in/`，全部保存成功后才写入 MySQL 排队。Worker 在该 UUID 目录执行，输出到 `out/`。提交成功后界面自动切到执行页，也可从任务列表或任务链接回看。

`POST /api/tasks` 支持 `multipart/form-data`：`prompt` 是任务描述（不超过 60,000 字节），`files` 是可重复的文件字段（1–10 个、单个不超过 25 MiB、请求不超过 100 MiB）。不接受路径型文件名或重名文件；上传验证失败不创建任务。成功返回 `202`，其中 `taskId` 用于查询、`taskid` 表示工作区目录，上传模式下两者是同一个 UUID。旧调用方仍可发送 JSON `{ taskid, prompt }`，使用预先准备好的 `<WORKSPACE_ROOT>/<taskid>/in/`。

每个新任务只能用一个新目录。失败任务可从界面重执行，确认前会列出当前 `out/` 文件；确认后整个旧 `out/` 会移动到任务目录的 `.previous-runs/`，再以空 `out/` 重新排队。过程文件与旧结果均保留，归档中的文件不会出现在当前任务文件列表。重跑会清除数据库中上一次的合同 JSON，避免对接接口返回旧结果。默认单 Worker、并发 1。Redis 断开时 API 仍可接收任务，Worker 定期对账补投 `queued` 任务。任务超时或 Worker 异常中断后标记失败，已写出的文件保留。

如果多个任务共用根目录下的技能，可在 `.env` 中设置 `TASK_PI_SKILL_DIR=contract-info-extraction`。Worker 会通过 `--skill` 加载 `<WORKSPACE_ROOT>/contract-info-extraction/SKILL.md`，但 Pi 仍在各自的任务目录中运行，无需复制技能。路径相对于 `WORKSPACE_ROOT`；未设置时保持 Pi 的默认发现行为。设置后目录或 `SKILL.md` 无效会在任务日志中明确报错。修改配置后重启 Worker。

Pi 配置目录管理全局资源，项目级 `.pi/skills/` 和 `.pi/extensions/` 按 Pi 的发现和授信规则加载。仅预先信任已审核项目，服务不会自动批准；需要弹窗交互的扩展不适合无人值守执行。Pi 读取的相关材料可能发送到配置的模型中转站。

UI 每两秒轮询；详情查看状态、日志、输入及输出文件。文本、Markdown、JSON、CSV 按纯文本显示，支持常见图片和浏览器 PDF 预览，其他文件可下载。预览上限 20 MiB，PDF 渲染取决于浏览器。日志记录工具名、开始与结束、耗时和关键参数（如操作路径、搜索条件、截断的 Shell 命令），扩展工具仅显示参数名。常见凭据会遮蔽，但脱敏不能识别所有自定义密钥格式，请勿在命令中直接填写密钥。工具日志不记录文件正文、写入内容或原始输出；prompt、最终回复及下述结构化合同结果会入库。每个任务最多记录 500 条事件，超过时显示截断提示。

## 合同提取产物和系统对接

当 `TASK_PI_SKILL_DIR` 指向 `contract-info-extraction` 目录时，Worker 会明确调用该技能，并要求每个新任务输出同一份提取结果的两种格式：

- `out/contract-result.md`：供人工核对。
- `out/contract-result.json`：供系统对接，UTF-8，最大 1 MiB。`schemaVersion: 1`，包含合同基础信息 `contractInfo`、逐行产品及要素 `products`、待确认问题 `questions`。每个要素保留原名、值、证据、判定来源和状态，值与单位作为字符串保留。
- OCR 等过程文件可放在 `out/process/`，执行结束不清理，失败时也保留已生成文件。

Worker 验证 Markdown 文件存在且非空、JSON 符合 v1 结构后，将 JSON 写入 MySQL 的 `contract_results.result_json`（JSON 类型）。结果与任务成功状态在同一事务提交；产物不完整、校验或入库失败时任务不会标记成功。业务字段及其正确性仍以合同原文和技能规则为准。

任务完成后可进入「核对结果」。待确认问题置顶，合同基础信息默认折叠。合同基础信息和产品提取值可编辑，点击「保存修改」将人工核对版写入 MySQL。判定来源和原文证据以只读备注并排显示，窄屏自动换行。

对接方可通过 `GET /api/tasks/<taskId>/contract-result` 读取 MySQL 中的结果。`taskId` 是提交接口返回的 UUID，沿用服务原有鉴权。成功返回 `{ taskId, taskid, result }`；未结束返回 `409`，无已入库结果返回 `404`。历史任务不会自动补录。`GET /api/tasks/<taskId>/contract-review` 获取最新核对版及 `revision`。首次核对前返回原始结果，版本为 `0`。浏览器通过同一路径的 `PUT` 提交 `{ revision, changes: { contractInfo, productValues } }`，`contractInfo` 是修改过的字段名和值，`productValues` 的每项包含从 `0` 开始的 `productIndex`、`fieldIndex` 以及字符串或 `null` 的 `value`。并发更新返回 `409`。`contract-result` 接口继续提供 AI 原始结果。升级时先执行 `npm run db:migrate`，再重启 API 和 Worker。

## 生产部署

- 使用 `npm ci` 锁定版本。API 和 Worker 必须使用同一份工作区（或共享卷及相同相对结构）。按独立服务启动，不使用共享的个人 Pi 配置目录。
- API 只绑定环回地址。使用 HTTPS 反代，保留外部 Host，将请求体大小上限设为至少 100 MiB（若允许完整上传限额），并配置 `NODE_ENV=production`、`HTTP_PUBLIC_ORIGIN`、`HTTP_AUTH_USER`、`HTTP_AUTH_PASSWORD`。当前 Basic Auth 是单一操作员角色，所有已认证用户均可查看全部任务；不适合直接用作多租户服务。
- `in/` 和 `out/` 是约定，不是沙箱。用低权限账号或容器隔离 Pi，限制可访问目录和网络。工作区只交给受信任的进程，不对任意第三方开放终端式任务执行。Redis 和 MySQL 不暴露公网。超时时 Worker 停止 Pi 主进程，生产应由容器或进程监督器清理其派生进程。

## 代码检查

```sh
npm run format        # Prettier 格式化
npm run format:check  # CI 中检查格式
npm run typecheck     # TypeScript 类型检查
```

- `src/api/`：任务查询、提交和文件预览
- `src/repositories/`：MySQL 连接、建表、状态和日志
- `src/worker/`：投递补偿、领取和执行任务
- `src/integrations/pi/`：跨平台 Pi CLI RPC
- `src/workspace/`：目录验证和文件访问
- `web/`：任务面板
