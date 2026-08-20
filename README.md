<p align="center">
  <img src="https://img.shields.io/badge/dsh-workspace--drag-Drag%20to%20Organize-4f8cff?style=for-the-badge&labelColor=1a1d24" alt="dsh-workspace-drag" />
</p>

<h1 align="center">dsh-workspace-drag</h1>

<p align="center">
  <b>DSH Web UI plugin — drag a conversation onto any workspace to organize it</b>
</p>

<p align="center">
  <code>drag session row → workspace group → move(cwd + files + registry)</code>
</p>

<p align="center">
  <a href="https://github.com/lanscer/dsh-workspace-drag/blob/main/README.zh.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-README.zh.md-10a37f?style=flat-square" alt="中文文档" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/badge/dsh-plugin-%E2%9C%93-4f8cff?style=flat-square" alt="DSH plugin" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-9aa4b2?style=flat-square" alt="Platform" />
</p>

---

**DSH Web UI plugin** — in the sidebar grouped view, drag a conversation onto another workspace's title (or any session row within that group) and release to move the conversation there. **Seamless drag-and-drop**: no popups, no intermediate panels — drop it and it's organized.

## Features

- **Seamless cross-workspace drag-and-drop**: drag a session row → hover over another workspace group (title or any session row within it) to highlight → release to migrate.
  - No floating panels, no confirmation dialogs; same-workspace drag-and-drop is left to DSH's native reordering, undisturbed.
  - A brief success banner appears after the move, and the conversation immediately appears in the target workspace.
- **Toggle**: enable/disable with one click on the **Settings → Drag to Organize** page; when disabled, drag-and-drop is inert (no highlighting, no migration).
- **Safety**:
  - Sessions that are currently being written to (agent running, log modified within the last 30 seconds) **cannot be moved**.
  - The host-side migration is a copy-verify-atomic-swap: the session directory is copied to a staging location, the rewritten log is verified, then published to the destination. The old directory is only removed after the new copy is verified — data is never lost on failure.
  - The migration physically relocates the session log file, rewrites the header `cwd` field, and updates the workspace registry ownership account.

## Data Model

- Each session's workspace identity is its header `cwd` (an absolute directory path).
- Sessions are stored at `~/.dsh/sessions/<projectKey(cwd)>/<session-id>/session.jsonl[.zstd]`.
- Migration = relocating the session directory under the new workspace's `projectKey` directory + rewriting the first (header) line's `cwd` + using `ctx.workspaceRegistry`'s detach/attach to update the workspace ownership ledger.
- zstd logs are **concatenated multi-frame containers**: frame 1 = exactly one header line (newline-terminated), frames 2..N = appended event batches. The DSH reader requires the **first frame to decode to exactly this header line**.
- During migration, zstd logs undergo **frame-preserving surgery**: only frame 1 is decoded → the header `cwd` is rewritten → re-encoded as a single checksummed frame (matching the DSH backend) → concatenated with the remaining original frames (byte-identical). The log must **never** be compressed as a single frame (that would break the DSH reader's "first frame = header only" invariant).

## File Layout

```
dsh-workspace-drag/
├── package.json          # dsh.bundle.patch + client inject
├── cordis.patch.yml      # registers the plugin row in the web profile
├── lib/
│   ├── index.js          # Host: config/move HTTP routes + migration logic
│   └── client.js         # Browser: settings page (toggle) + document-level drag engine
├── test/
│   ├── fixtures/multiframe-session.jsonl.zstd  # multi-frame zstd session sample (7 frames)
│   ├── verify-core.mjs              # zstd round-trip + DSH frame scanner compatibility
│   └── integration-move.mjs         # end-to-end integration test for moveSessionToWorkspace
└── README.md
```

## Host HTTP API

| Method | Path | Description |
| --- | --- | --- |
| GET  | `/api/dsh-workspace-drag/config` | Read toggle `{ "enabled": true }` |
| POST | `/api/dsh-workspace-drag/config` | Write toggle `{ "enabled": false }` |
| POST | `/api/dsh-workspace-drag/move` | `{ "sessionId", "targetWorkspaceId" }` — move a conversation |

Configuration is persisted in `~/.dsh/dsh-workspace-drag.json`.

## Dependencies

- The host half requires the `zstd` CLI. The plugin auto-detects the binary via `PATH` search, falling back to common paths (`/opt/homebrew/bin/zstd`, `/usr/local/bin/zstd`, `/usr/bin/zstd`). Install via `brew install zstd` (macOS) or `apt install zstd` (Linux).
- Requires DSH built-in services: `webServer` / `sessions` / `sessionPersistence` / `workspaceRegistry`
  (all loaded by `@deepseek-ai/dsh-web-app`).

## Tests

```bash
cd test
node verify-core.mjs      # Validate zstd round-trip + DSH frame scanner compatibility
node integration-move.mjs # End-to-end integration test (temp directory, does not touch real data)
```

## Limitations

- Sessions being actively written to (agent running, log modified within the last 30 seconds) cannot be moved.
- Migration changes the session's `cwd` — its workspace ownership and disk storage location. This is the essence of "organizing into a workspace."
- The `zstd` CLI must be installed (auto-detected via PATH; no hardcoded path).

## License

[MIT](LICENSE)

---

<p align="center">
  <a href="https://github.com/lanscer/dsh-workspace-drag/blob/main/README.zh.md"><b>中文文档</b></a> · <a href="https://github.com/lanscer/dsh-workspace-drag">English</a>
</p>
