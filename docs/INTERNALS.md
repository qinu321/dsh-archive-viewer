# 原理与实现

本文件记录 `dsh-archive-viewer` 的机制、宿主路由、只读边界与开发自检，面向想读懂或修改它的人。使用说明见 [README](../README.md)。

## 它解决的问题

DSH 的官方界面**不允许把已归档会话显示为当前视图**（`dsh-client-ui-workspace` 的 `guardedOpen`：命中归档集就弹提示并返回）。既有的唯一读法是「先取消归档 → 看完 → 再手动归档」，每次都会改动持久化状态，并把会话临时塞回工作区列表。

但归档只是一个**导航层限制，不是数据层限制**：

- 归档集是 `workspaceRegistry.archivedSessionIds`（落盘在 `<DSH_HOME>/storages/workspace.json`），只决定“哪些会话从列表里隐藏”；
- 会话日志始终可读 —— DSH 自己的 `/api/session.export` 路由就是按 sessionId 直接读持久化日志的；
- 归档会话**不能被喂模型**（`archived-session-gate` 会拒绝 `agent/pre-step`）——这一条本插件不碰。

本插件补的就是「只读地看」这一层：**查看不写任何状态**。

## 数据来源：列表为什么没有条数上限

列表**不由宿主分页返回**，而是直接从 DSH 自己的客户端会话库派生：

- `ctx.sessions.list`（`{ ids, byId }`）里本来就有**已归档会话**——官方工作区视图的「显示已归档」就是对同一份 `list.ids` 按 `archivedSessionIds` 过滤出来的（`sessionVisible`）；每行的 `displayTitle`、`cwd`、`updatedAt` 都是现成的；
- 归档集与工作区归属来自 `ctx.workspaces.list` 的快照（`archivedSessionIds` + 每个工作区的 `sessionIds`），归档/取消归档后**实时**生效；
- 客户端快照里没有的三样东西——`createdAt`、日志字节数、内部机器的排除名单——由宿主在 `GET /archive-viewer/api/meta` 里**一次返回、不分页**：`createdAt` 读注册表的内存 header 索引，字节数用 15 秒缓存的目录扫描，排除名单用同一份 header/目录信息。

因此打开面板等于一次内存快照渲染 + 一次很小的元数据请求；归档有多少条都不会出现「第 501 条翻不到」。渲染是**分段窗口**（每次 200 行，纯前端「显示更多」），那只是 DOM 成本，不构成数据上限。

## 按工作区筛选

下拉框的选项是**有归档会话的工作区**（带条数，如 `debug（44）`），加一个 `未分组（n）`（只有当存在不属于任何工作区的会话时才出现）。选择后由**客户端在整份归档集上过滤**，不是过滤已经画出来的那一段：归档集大于一屏时，只过滤可见行会让「该工作区只有 3 条」这种结论在数据上站不住（`总数`、`显示更多` 都以过滤后的集合为准）。

会话归属工作区按两级判定（与「会话管理」插件同口径）：

1. **注册表成员关系**（`workspace.sessionIds`）—— 权威来源，归档会话保留其成员槽位；
2. 否则按会话的 `cwd` 匹配工作区 `path`（路径分隔符、结尾斜杠、盘符大小写都不影响匹配）。

两级都命中不了就是「未分组」。**筛选下的行显示的是「筛中的那个工作区」**：一个会话被多个工作区记账时，选项里每个工作区都计入它——因为每个选项回答的是「选它会看到几条」；代价是**各选项条数之和可能大于「全部工作区（N）」**。

**顺序 = 整份集合里最新的在前**（按 `createdAt`，缺失时用日志 mtime、再退到 `updatedAt`）。排序在派生时一次完成。

选择的工作区**丢掉了最后一条归档会话**时（在别处取消归档、或清掉残留记录），它的选项会消失，此时下拉框立即按「全部工作区」作答，**并在列表上方写明发生了什么**——不声不响地清空选择读起来就像 bug。工作区归属不依赖宿主的持久化读取：成员关系与 `cwd` 都来自客户端快照，所以宿主读会话失败不会让某个工作区显示成「空的」。

## 正文：读完整日志，不读模型面

宿主用 `sessionQuery.readSession()` 读**完整日志**折行，而不是 `readSurface()`（模型当前视图）。原因有两条，都是 DSH 有意为之的 surface 替换：

- **上下文压缩**：`compaction/summary` 事件带 `shadowedRange` / `shadowedSeqs` 与摘要正文，随后追加一条 `user/message`，其 `surfaceOp` 为 `{op:'replace', startSeq, endSeq}`。surface 会把这段区间折掉、只留检查点，所以读 surface 的阅读器会看到「第一条消息变成检查点摘要」；原始事件仍在日志里。
- **工具结果剪枝**：`compaction/prune` 之后追加一条带 `replace` 的 `tool/result` 替代旧结果，原文同样保留在日志里。

渲染规则：

- `compaction/summary` 渲染成一张「上下文压缩」卡片（折叠条数、摘要可展开，上限 24000 字），同一区间的检查点 `user/message` 跳过；
- 工具结果配对时跳过 `replace` 的替代行，取原文；
- agent loop 用来重置运行时上下文系统消息的空 `system/message` 跳过；
- 只有工具调用、没有正文也没有思考的 `assistant/message` 不再生成空卡（工具调用本身有独立行）；被打断的步骤保留，badge 是唯一的记录。

单条会话最多渲染最近 4000 行（超出会在顶部注明），单个文本块截断 8000 字符。行上限按本机最大压缩会话折出的约 1700 行留了余量，避免把开头切掉。

## 只读保证

| 行为 | 是否发生 |
|---|---|
| 列出归档会话 | 读客户端已有的会话快照；宿主只为整份归档集做一次注册表/目录读取（不写盘） |
| 读取会话正文 | `sessionQuery.readSession()`（**完整日志**，不读模型面），**不激活 Agent** |
| 打开弹窗、切换会话 | 无任何副作用 |
| 点「恢复并继续对话」 | 取消归档（用户显式点击，唯一写操作） |

## 宿主路由

- `GET /archive-viewer/api/meta`：整份归档集的 `createdAt` / `bytes` / `mtime` 稀疏映射、`excluded`（内部机器会话 id）、`archivedIdCount`；`refresh=1` 强制重扫目录。
- `GET /archive-viewer/api/transcript?sessionId=…`：折好的正文行；对**不在归档集里**的会话直接拒绝（409），避免变成第二个会话阅读器。
- `GET /archive-viewer/api/workspaces`：注册表里的工作区（只读）。
- `POST /archive-viewer/api/unarchive`：取消归档，只从「恢复并继续对话」按钮调用。
- `POST /archive-viewer/api/forget`：清理归档集里指向已不存在会话的残留 id；会话仍存在则 409 拒绝，不碰任何会话内容。
- `GET /archive-viewer/api/sessions`：**旧列表路由，保留作回滚兼容，客户端已不再调用**。参数 `limit`（页大小，硬上限 500）、`refresh=1`、`workspace=<工作区 id>` 或 `workspace=ungrouped`。

## 客户端半边

`inject = ["slots", "locale", "uiWorkspace", "sessions", "workspaces"]`：后两个就是列表的数据源（DSH 自己的会话/工作区快照）。客户端**不 import 任何 DSH 客户端包**——组件、样式、控件全部自己写，只用 `--dsw-alias-*` 主题令牌（滚动条用 `--dsw-alias-scrollbar-bg-l2` / `--dsw-alias-scrollbar-hover-l2`）。

两个滚动区自绘常驻滚动条：Windows「自动隐藏滚动条」下 Chromium 的 overlay 条只在滚动时闪现，读者没有位置参照。列表与正文在切片变化时（换工作区/搜索、换会话）显式把 `scrollTop` 归零。

## 页面侧诊断（图标 / 弹窗排查用）

有些失败只存在于浏览器里（Client 工厂没跑、`apply` 抛错、渲染抛错、图标不在 DOM 里），从外面看不见——因此留了一条**只读的页面→宿主诊断通道**：

- `POST /archive-viewer/api/diagnostic`：页面把观察到的状态报上来；宿主**只留在内存**（不落盘、不碰会话状态）；
- `GET /archive-viewer/api/diagnostic`：读回最后一份报告；
- Client 半边在三个点自动上报：**工厂启动**（`factory:start`）、**注册完成**（`apply:registered`）、**渲染抛错**（`render:crash`）；
- `page-diagnostic.js` 是更全的一次性探针：整份粘进 DSH 页面的 DevTools 控制台，它会检查模块加载器、slot 条目、侧边栏底部 DOM 与自身路由可达性，然后自动 POST 回宿主（同时 `console.log` 一份）。

## 配置

插件不带 Config（保持零依赖，不引 `@deepseek-ai/schemastery`）。可选的 patch 行字段：

```yaml
- id: dsh-archive-viewer
  config:
    dshHome: 'D:\dsh-home'           # 解析优先级：该字段 → $DSH_HOME → ~/.dsh
    excludeWorkspacePaths: []         # 默认 ["aik_auto_memory_use"]；传 [] 关闭排除
```

`excludeWorkspacePaths` 按会话 `cwd` 的路径段匹配，目录名、尾斜杠与盘符大小写都不影响；排除的会话会在列表底部标注条数。

## 依赖

宿主半边 `inject = ["webServer", "workspaceRegistry", "sessionQuery"]`。三者缺任一，插件保持未激活而不抛错。客户端半边见上。

## 自检

以下命令在**仓库检出**里运行（自检文件不随 npm 包发布）：

```node selftest.mjs                            # 离线：折叠逻辑、路由、/meta、压缩/剪枝/空步骤、工作区解析/排序、客户端形状（195 项）
node client-selftest.mjs                     # 离线客户端 harness：工厂/apply/slot/渲染、快照派生的列表、窗口与筛选（87 项）
ARCHIVE_VIEWER_LIVE=1 node selftest.mjs      # 追加真实归档库检查（条数/工件/陈旧 ID + /meta 与旧列表对账）
```

离线自检不依赖 DSH 运行时；`ARCHIVE_VIEWER_LIVE=1` 时读取 `$DSH_HOME` 下的真实归档库（未设置时用 `selftest.mjs` 里的默认目录）。

## 已知边界

- **不能在归档状态下继续对话**——想接着聊必须取消归档，这是 DSH 的设计，本插件不绕过；
- **两半要一起更新**：客户端从 `/meta` 取创建时间与日志大小，只刷新页面而宿主还是旧进程时，列表仍可浏览，但会提示「未能读取创建时间与日志大小（宿主无响应）」；重启 DSH 后消失；
- 工作区下拉框只列**有归档会话**的工作区（空工作区不入列），因此「选完发现列表空了」不会发生——那种情况会自动退回「全部工作区」；
- 「未分组」只在确实存在不属于任何工作区的归档会话时出现；
- 列表是**分段渲染**的（每次 200 行），「显示更多」不发任何请求；这限制的是 DOM 行数，不是归档条数；
- 单条会话最多渲染 4000 行，单个文本块截断 8000 字符，压缩摘要放宽到 24000 字符；
- 归档集里指向已不存在会话的陈旧 ID 会列出并标为「日志缺失」，不会伪造内容。
