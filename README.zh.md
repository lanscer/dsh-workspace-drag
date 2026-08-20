<p align="center">
  <img src="https://img.shields.io/static/v1?label=dsh-workspace-drag&message=%E6%8B%96%E6%8B%BD%E5%BD%92%E7%B1%BB%E5%AF%B9%E8%AF%9D&color=4f8cff&style=for-the-badge&labelColor=1a1d24" alt="dsh-workspace-drag" />
</p>

<h1 align="center">dsh-workspace-drag</h1>

<p align="center">
  <b>DSH Web UI 插件 — 把对话拖到任意工作区即可归类整理</b>
</p>

<p align="center">
  <code>拖起会话行 → 悬停工作区组 → 迁移(cwd + 文件 + 归属账本)</code>
</p>

<p align="center">
  <a href="https://github.com/lanscer/dsh-workspace-drag"><img src="https://img.shields.io/static/v1?label=English&message=README.md&color=4f8cff&style=flat-square" alt="English" /></a>
  <img src="https://img.shields.io/static/v1?label=license&message=MIT&color=green&style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/static/v1?label=dsh-plugin&message=%E2%9C%93&color=4f8cff&style=flat-square" alt="DSH plugin" />
  <img src="https://img.shields.io/static/v1?label=platform&message=macOS%20%7C%20Linux&color=9aa4b2&style=flat-square" alt="Platform" />
</p>

---

**DSH Web UI 插件** — 在侧边栏（分组视图）里，把一个**历史对话**直接拖到**另一个工作区的标题**（或该组内任意会话行）上松开，
就能把这个对话归到目标工作区，实现跨工作区的对话分类整理。**无感拖拽**：没有弹窗、没有中间面板，拖到哪就归到哪。

## 功能

- **无感跨工作区拖拽**：侧边栏分组视图中，拖起会话行 → 悬停在另一个工作区组（标题或组内任意会话行）上高亮 → 松开即迁移。
  - 无浮动面板、无确认弹窗；同工作区内的拖放仍走 DSH 原生排序，互不干扰。
  - 成功后短暂提示，会话立即出现在目标工作区。
- **开关**：在 **设置 → 拖拽归类对话** 页面一键启用/关闭；关闭后拖拽不生效（高亮/迁移都被禁用）。
- **安全**：
  - 正在写入中的会话（Agent 运行中，日志在过去 30 秒内被修改）**不能移动**。
  - 迁移在宿主端先复制 + 校验新文件，确认无误后才删除旧目录，失败不丢数据。
  - 移动的是会话日志文件的物理位置 + 头部 `cwd` 字段，并同步工作区注册表归属账本。

## 原理（数据层）

- DSH 每个会话的工作区身份 = 其头部 `cwd`（绝对目录路径）。
- 会话存储于 `~/.dsh/sessions/<projectKey(cwd)>/<会话id>/session.jsonl[.zstd]`。
- 迁移 = 把会话目录移动到目标工作区的 `projectKey` 目录下 + 重写第一行（header）的 `cwd` + 用
  `ctx.workspaceRegistry` 的 detach/attach 更新工作区归属账本。
- zstd 日志是**拼接多帧容器**：帧 1 = 恰好一行 header（以换行结尾），帧 2..N = 每次追加的事件批次；
  DSH 读取器要求**第一帧独立解码后恰好是这一行 header**。
- 迁移时对 zstd 日志做**帧保留手术**：只解码帧 1 → 改写 header 的 `cwd` → 重编码为单帧（带 checksum，
  与 DSH 后端一致）→ 与其余原始帧（逐字节不变）拼接。**绝不能**把整个日志压成单帧（会破坏 DSH
  读取器的"第一帧=仅 header"不变量）。

## 文件

```
dsh-workspace-drag/
├── package.json          # dsh.bundle.patch + client inject
├── cordis.patch.yml      # 向 web profile 注册插件行
├── lib/
│   ├── index.js          # 宿主端：config/move 两个 HTTP 路由 + 迁移逻辑
│   └── client.js         # 浏览器端：设置页(开关) + document 级拖拽引擎
├── test/
│   ├── fixtures/multiframe-session.jsonl.zstd  # 多帧 zstd 会话样本（7 帧）
│   ├── verify-core.mjs              # zstd 往返 + DSH 帧扫描器兼容校验
│   └── integration-move.mjs         # moveSessionToWorkspace 端到端集成测试（含帧数保持断言）
└── README.md
```

## 宿主端 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/api/dsh-workspace-drag/config` | 读开关 `{ "enabled": true }` |
| POST | `/api/dsh-workspace-drag/config` | 写开关 `{ "enabled": false }` |
| POST | `/api/dsh-workspace-drag/move` | `{ "sessionId", "targetWorkspaceId" }` 迁移对话 |

配置持久化在 `~/.dsh/dsh-workspace-drag.json`。

## 依赖

- 宿主端需要 `zstd` CLI。插件自动通过 `PATH` 查找，找不到再 fallback 到常见路径（`/opt/homebrew/bin/zstd`、`/usr/local/bin/zstd`、`/usr/bin/zstd`）。macOS 通过 `brew install zstd` 安装，Linux 通过 `apt install zstd` 安装。
- 需要 DSH 内置服务：`webServer` / `sessions` / `sessionPersistence` / `workspaceRegistry`
  （`@deepseek-ai/dsh-web-app` 已全部加载）。

## 测试

```bash
cd test
node verify-core.mjs      # 校验 zstd 往返 + DSH 帧扫描兼容
node integration-move.mjs # 端到端集成测试（临时目录，不碰真实数据）
```

## 使用限制

- 正在写入中的对话（Agent 运行中，日志在过去 30 秒内被修改）不能移动。
- 迁移会改变会话的 `cwd`，也就是它所属的工作区与磁盘存储位置；这是"归到某工作区"的本质。
- 需要 `zstd` CLI 已安装（自动 PATH 检测，无硬编码路径）。

## License

[MIT](LICENSE)

---

<p align="center">
  <b>中文</b> · <a href="https://github.com/lanscer/dsh-workspace-drag">English</a>
</p>
