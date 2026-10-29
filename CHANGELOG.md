# 更新记录（dsh-archive-viewer）

> 查「现在怎么用」看 `README.md`，查「原理与边界」看 `docs/INTERNALS.md`；本文件只记版本之间的差异。新增版本写在本文件顶部。
> ≤1.1.3 的改动没有逐条记录，需要时翻 git 历史。

---

## v1.1.4（2026-10-29：声明宿主 DSH 版本要求）

`package.json` 补 `engines.dsh = ">=0.2.0-rc.1"`，并把 `CHANGELOG.md` 加进 `files` 随包发布。

- **为什么**：插件市场的「宿主要求」读 manifest 的 `engines.dsh`（没有再读 `dsh.engines.dsh`，都没有才回落 `@deepseek-ai/*` peer 范围）。不声明时市场行只能显示「未声明宿主要求」，安装预检也没有东西可判断。
- **影响面**：只改包元数据 —— `host.js`、`client.js`、`cordis.patch.yml`、`locale/`、`docs/`、`assets/` 与三个自检脚本零改动；路由、只读保证、压缩点与滚动条行为与 1.1.3 一致。
- **兼容性**：`>=0.2.0-rc.1` 覆盖 DSH 0.2.x 全线（含 `0.2.2-alpha.*` 这类预发布版本，市场/安装预检按 `includePrerelease` 口径判定）。
