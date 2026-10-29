# 更新记录（dsh-archive-viewer）

> 查「现在怎么用」看 `README.md`，查「原理与边界」看 `docs/INTERNALS.md`；本文件只记版本之间的差异。新增版本写在本文件顶部。
> ≤1.1.3 的改动没有逐条记录，需要时翻 git 历史。

---

## v1.1.5（2026-10-29：修「不是用户的话被标成用户发言」与「（无正文）」空卡）

### 修了什么

1. **「用户」只留给真正手打的消息**。折叠逻辑改成按 DSH 自己的口径判谁在说话：人类提示是唯一 `source.kind === "user"` 的 `user/message`，其它 kind 都是某个 producer 的注入上下文（联合类型可扩展，抄名单必然漏）。旧白名单只认三种 kind 加两条文本前缀，所以：
   - `time-context` 的时间戳快照（`Time sampled while preparing turn … / Browser time zone for this request: …`）曾显示成「用户 · …」——现在是注入上下文行，标签 `time-context`；
   - `tool-jobs` 的后台任务完成通知（`background job … finished [status: …]. Output: …`）同样曾冒充用户发言——现在是注入上下文行，并按 producer 提交的 `source.summary` 读成一行摘要 +「查看原始内容」可展开。
2. **`source.form === "relay"` 单独成「转述 · <producer>」行**：别的会话 / agent 转述进来的消息属于对话而非上下文，仍然可见（不随注入上下文折叠），只是不再算作本会话用户说的话。实测本机 9,612 条转述（`plugin:dsh-chat`、`plugin:dsh-bridge` 等）。
3. **`session/end-seed` 不再是「（无正文）」空卡**。它是日志层的生命周期标记（继承/恢复的历史到此为止），本身没有正文；现在读成一行分隔线「继承/恢复的历史到此为止 · <时间>」，带 `inherited: true` 的 fork 切口不渲染。
4. **顺手收掉其它空行**：没有值的 notice、没有内容也没有摘要的注入上下文都不再生成卡片（整库回放：0 张空卡）。

### 实测口径

本机 413 个归档会话、20,202 条 `user/message` 全量离线回放：用户行从「混着系统文本」变成 **4,247 行 = 4,247 条 `kind === "user"` 事件**（一一对应）；注入上下文 6,932 行、转述 9,612 行、生命周期分隔线 783 行；「看起来像用户发言的系统文本」与「空卡」均为 0。

### 兼容性

- 路由、只读保证、压缩点、列表派生、滚动条行为与 1.1.4 一致；
- 老日志（没有 `source`）退回文本前缀判定，行为与 1.1.4 相同；
- **宿主半边要重启 `dsh web` 才生效**（折叠逻辑在 `host.js`）；只刷页面会看到新面板 UI + 旧折叠结果。

## v1.1.4（2026-10-29：声明宿主 DSH 版本要求）

`package.json` 补 `engines.dsh = ">=0.2.0-rc.1"`，并把 `CHANGELOG.md` 加进 `files` 随包发布。

- **为什么**：插件市场的「宿主要求」读 manifest 的 `engines.dsh`（没有再读 `dsh.engines.dsh`，都没有才回落 `@deepseek-ai/*` peer 范围）。不声明时市场行只能显示「未声明宿主要求」，安装预检也没有东西可判断。
- **影响面**：只改包元数据 —— `host.js`、`client.js`、`cordis.patch.yml`、`locale/`、`docs/`、`assets/` 与三个自检脚本零改动；路由、只读保证、压缩点与滚动条行为与 1.1.3 一致。
- **兼容性**：`>=0.2.0-rc.1` 覆盖 DSH 0.2.x 全线（含 `0.2.2-alpha.*` 这类预发布版本，市场/安装预检按 `includePrerelease` 口径判定）。
