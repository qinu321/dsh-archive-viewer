# dsh-archive-viewer

已归档 **DSH（DeepSeek Harness）会话**的只读查看器：不取消归档，就能浏览归档列表、阅读完整对话与工具调用。

![归档会话查看器：左栏是归档列表（可按工作区筛选），右栏是完整对话（思考过程可折叠，工具调用与结果可展开）](https://cdn.jsdelivr.net/npm/dsh-archive-viewer/assets/screenshot.jpg)

## 功能

- **侧边栏入口**：在「会话管理」右侧。侧边栏展开时是图标 + 「查看归档」的整行，收起成窄条时只剩图标（悬停有同名提示），点开查看器弹窗。
- **归档列表**：标题、创建时间、所属工作区、日志大小、缺失标记；支持按标题 / 会话 ID / 工作区搜索，以及按工作区筛选。
- **没有条数上限**：列表直接来自 DSH 自己的客户端会话快照，打开即渲染，不按页向宿主索取；渲染每次 200 行，「显示更多」不发任何请求。
- **完整对话**：用户消息、助手消息（思考过程可折叠）、工具调用与结果（参数与结果可展开）、轮次边界、注入的上下文与系统事件摘要。
- **压缩点可读**：发生过上下文压缩的会话，压缩处显示「上下文压缩」卡片（折叠了哪些记录、摘要可展开），压缩前的对话按原文照常显示；被剪枝的旧工具结果也保留原文。
- **只读**：横幅明确标注；唯一的写操作是「恢复并继续对话」——点击后取消归档并打开会话，归档状态在此之前不会被改动。
- **中英双语**：界面文案随 DSH 语言切换。

## 安装

npm 包名 `dsh-archive-viewer`。装进某个 profile：

```
dsh plugin --profile <你的 profile> add dsh-archive-viewer
```

命令把参数转发给该 profile 的 pnpm；成功后会把声明了 `dsh.bundle` 的插件登记进 `dsh.profile.bundles` 并自动启用。**重启 `dsh web` 生效**（宿主半边在启动时加载）。

也可以走插件面板，或使用工具：

```
plugin_manager { action: "install_bundle", target: "dsh-archive-viewer" }
```

**从本地目录开发**：把 target 换成该目录的绝对路径，会装成 `link:` 依赖；只改 `client.js` 时，若 `pnpm run dev:web` 在跑，前端会热更新。

## 卸载

```
dsh plugin --profile <你的 profile> remove dsh-archive-viewer
```

或 `plugin_manager { action: "remove_bundle", target: "dsh-archive-viewer" }`。移除后入口与面板消失，归档状态与会话内容都不受影响。

## 配置

插件不带 Config（保持零依赖，不引 Schemastery）。需要时在 patch 行里给字段：

```yaml
- id: dsh-archive-viewer
  config:
    dshHome: 'D:\dsh-home'          # 非标准数据目录；默认 $DSH_HOME，再退回 ~/.dsh
    excludeWorkspacePaths: []        # 覆盖默认的内部会话排除名单（默认 ["aik_auto_memory_use"]）
```

## 文档

- 原理与实现（数据来源、路由表、只读保证、压缩处理、诊断通道、自检与已知边界）：仓库内的 `docs/INTERNALS.md`
- 许可证：MIT，见仓库根目录的 `LICENSE`

仓库：https://github.com/qinu321/dsh-archive-viewer

## 兼容性

已在 DSH `0.2.2-alpha.2`（Web UI）验证。宿主服务 `webServer` / `workspaceRegistry` / `sessionQuery` 缺任一，插件保持未激活而不抛错。
