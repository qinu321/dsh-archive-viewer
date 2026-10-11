# dsh-archive-viewer

已归档 **DSH 会话**的只读查看器：不取消归档，就能读完整对话与工具调用。

## 它解决的问题

DSH 的官方界面**不允许把已归档会话显示为当前视图**（`dsh-client-ui-workspace` 的 `guardedOpen`：命中归档集就弹提示并返回）。
所以既有的唯一读法是「先取消归档 → 看完 → 再手动归档」，这**每次都会改动持久化状态**，并把会话临时塞回工作区列表。

但归档只是一个**导航层限制，不是数据层限制**：

- 归档集是 `workspaceRegistry.archivedSessionIds`（落盘在 `<DSH_HOME>/storages/workspace.json`），只决定"哪些会话从列表里隐藏"；
- 会话日志始终可读 —— DSH 自己的 `/api/session.export` 路由就是按 sessionId 直接读持久化日志的；
- 归档会话**不能被喂模型**（`archived-session-gate` 会拒绝 `agent/pre-step`）——这一条本插件不碰。

本插件补的就是「只读地看」这一层：**查看不写任何状态**。

## 它做什么

- 侧边栏底部多一个图标（在「会话管理」图标右侧），打开**归档会话查看器**弹窗；
- 左栏：全部已归档会话（标题 / 创建时间 / 所属工作区 / 日志大小 / 缺失标记），支持按标题、ID、工作区搜索；
- 右栏：**完整对话** —— 用户消息、助手消息（思考过程可折叠）、工具调用与结果（参数与结果均可展开）、轮次边界、注入的上下文与系统事件摘要；
- 顶部横幅标明只读，并给出唯一的写操作按钮 **「恢复并继续对话」** —— 只有点了它才会取消归档（调用官方 `uiWorkspace.unarchiveSession` 并顺带打开会话）。

## 只读保证

| 行为 | 是否发生 |
|---|---|
| 列出归档会话 | 只读注册表 + 目录扫描，不写盘 |
| 读取会话正文 | `sessionQuery.readSession()` / `readSurface()`，**不激活 Agent** |
| 打开弹窗、切换会话 | 无任何副作用 |
| 点「恢复并继续对话」 | 取消归档（用户显式点击，唯一写操作） |

宿主半边的路由：`GET /archive-viewer/api/sessions`、`GET /archive-viewer/api/transcript?sessionId=…`、
`GET /archive-viewer/api/workspaces`、`POST /archive-viewer/api/unarchive`。
`/transcript` 对**不在归档集里**的会话直接拒绝（409），避免变成第二个会话阅读器。

## 页面侧诊断（图标 / 弹窗排查用）

有些失败只存在于浏览器里（Client 工厂没跑、`apply` 抛错、渲染抛错、图标不在 DOM 里），从外面看不见 ——
因此留了一条**只读的页面→宿主诊断通道**：

- `POST /archive-viewer/api/diagnostic`：页面把观察到的状态报上来；宿主**只留在内存**（不落盘、不碰会话状态）；
- `GET /archive-viewer/api/diagnostic`：读回最后一份报告；
- Client 半边在三个点自动上报：**工厂启动**（`factory:start`）、**注册完成**（`apply:registered`）、**渲染抛错**（`render:crash`）；
- `page-diagnostic.js` 是更全的一次性探针：整份粘进 DSH 页面的 DevTools 控制台，它会检查模块加载器、slot 条目、
  侧边栏底部 DOM 与自身路由可达性，然后自动 POST 回宿主（同时 `console.log` 一份）。

## 安装 / 卸载

```
plugin_manager { action: "install_bundle", target: "E:\\codeVibe\\debug\\plugins\\dsh-archive-viewer" }
plugin_manager { action: "remove_bundle", target: "dsh-archive-viewer" }
```

安装走 DSH 插件管理流程（`install_bundle` 自己会改 profile 的 `package.json` 与 bundle 选择，不要手写）。
**宿主半边改动需要重启 DSH 才生效**；只改 `client.js` 时若 `pnpm run dev:web` 在跑，前端会热更新。

## 配置

插件不带 Config（保持零依赖，不引 `@deepseek-ai/schemastery`）。若要指向非标准数据目录，可在 patch 行里给一个字段：

```yaml
- id: dsh-archive-viewer
  config:
    dshHome: 'E:\DeepSeek Harness'
```

解析优先级：该字段 → `$DSH_HOME` → `~/.dsh`。留空即自动。

## 依赖

`inject = ["webServer", "workspaceRegistry", "sessionQuery"]`。三者缺任一，插件保持未激活而不抛错。
客户端半边 `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-workspace` 与 `@deepseek-ai/dsh-client-ui-slots`，
但**不 import 任何 DSH 客户端包** —— 组件、样式、控件全部自己写，只用 `--dsw-alias-*` 主题令牌。

## 自检

```
node selftest.mjs                            # 离线：折叠逻辑、路由、错误分支、客户端形状（68 项）
ARCHIVE_VIEWER_LIVE=1 node selftest.mjs      # 追加真实归档库检查（条数/工件/陈旧 ID）
```

## 已知边界

- **不能在归档状态下继续对话** —— 想接着聊必须取消归档，这是 DSH 的设计，本插件不绕过；
- 单条会话最多渲染最近 1200 条记录（超出会在顶部注明），单个文本块截断 8000 字符；
- 归档集里指向已不存在会话的陈旧 ID 会列出并标为「日志缺失」，不会伪造内容。
