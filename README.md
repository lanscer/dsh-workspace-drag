<p align="center">
  <img src="https://img.shields.io/static/v1?label=dsh-workspace-drag&message=Drag%20to%20Organize&color=4f8cff&style=for-the-badge&labelColor=1a1d24" alt="dsh-workspace-drag" />
</p>

<h1 align="center">dsh-workspace-drag</h1>

<p align="center">
  <b>DSH Web UI plugin — drag a conversation onto any workspace to organize it</b>
</p>

<p align="center">
  <code>drag session row → workspace group → move(cwd + files + registry)</code>
</p>

<p align="center">
  <a href="https://github.com/lanscer/dsh-workspace-drag/blob/main/README.zh.md"><img src="https://img.shields.io/static/v1?label=%E4%B8%AD%E6%96%87&message=README.zh.md&color=10a37f&style=flat-square" alt="中文文档" /></a>
  <img src="https://img.shields.io/static/v1?label=license&message=MIT&color=green&style=flat-square" alt="License: MIT" />
  <img src="https://img.shields.io/static/v1?label=dsh-plugin&message=%E2%9C%93&color=4f8cff&style=flat-square" alt="DSH plugin" />
  <img src="https://img.shields.io/static/v1?label=platform&message=macOS%20%7C%20Linux&color=9aa4b2&style=flat-square" alt="Platform" />
</p>

---

**DSH Web UI plugin** — in the sidebar grouped view, drag a conversation onto another workspace's title (or any session row within that group) and release to move the conversation there. **Seamless drag-and-drop**: no popups, no intermediate panels — drop it and it's organized.

## Installation

One-command install into the DSH web profile. **Run this from inside the plugin directory** (the folder containing `package.json` — after cloning `dsh-workspace-drag`, `cd` into it first):

```sh
npm run install:plugin
```

Or directly (cross-platform, uses Node.js):

```sh
node install-plugin.mjs
```

Works on **Windows (PowerShell), macOS and Linux** — the installer is a plain Node.js script, no bash or PowerShell-specific syntax.

This registers the plugin into `~/.dsh/profiles/web` (on Windows: `%USERPROFILE%\.dsh\profiles\web`) by adding a `link:` dependency to the profile's `package.json` and creating a `node_modules` symlink. It does **not** run `pnpm install`, so it avoids the pnpm `minimumReleaseAge` policy that rejects dependencies published within the last 24 hours. Idempotent — re-running is a no-op when already installed.

> ⚠️ **Windows notes**
> - Run the command **inside the cloned plugin folder**, not in your home directory — `npm run` needs a `package.json` in the current directory (the error `ENOENT ... C:\Users\<you>\package.json` means you ran it in the wrong folder).
> - Creating the symlink uses `junction`, which works on Windows without Developer Mode or Administrator rights.
> - If symlink creation is blocked by policy, the `link:` dependency is still written to the profile — then finish with `dsh plugin --profile web add link:<plugin-path>`.

After installation:
- Client-only changes: refresh the browser page.
- Host changes: restart `dsh web`.

> Note: the plugin requires the `zstd` CLI (see [Dependencies](#dependencies)).

## Features

- **Seamless cross-workspace drag-and-drop**: drag a session row → hover over another workspace group (title or any session row within it) to highlight → release to migrate.
  - No floating panels, no confirmation dialogs; same-workspace drag-and-drop is left to DSH's native reordering, undisturbed.
  - A brief success banner appears after the move, and the conversation immediately appears in the target workspace.
- **Toggle**: enable/disable with one click on the **Settings → Drag to Organize** page; when disabled, drag-and-drop is inert (no highlighting, no migration).
- **Safety**:
  - Sessions whose agent is currently running **cannot be moved** (exact agent-status check, no more coarse 30-second mtime window).
  - For a conversation that just finished: the host automatically waits for the log to quiesce (up to 15 s) and then migrates — one drop completes the move, no "retry later" loop.
  - The host-side migration is a copy-verify-atomic-swap: the session directory is copied to a staging location, the rewritten log is verified, then published to the destination. The old directory is only removed after the new copy is verified — data is never lost on failure.
  - The migration physically relocates the session log file, rewrites the header `cwd` field, and updates the workspace registry ownership account plus in-memory state (live header / persistence-coordinator cache / registry index), so the conversation remains usable after the move.

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
| POST | `/api/dsh-workspace-drag/move` | `{ "sessionId", "targetWorkspaceId", "waitMs" }` — move a conversation; optional `waitMs` (0–30000) makes the host wait for the agent/log to quiesce and finish automatically; failures carry a `code` (`agent-running` / `writing` / `move-failed`) |

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

- Conversations whose agent is currently running cannot be moved (you are asked to wait for the reply to finish); for a just-finished conversation the host waits for the log to quiesce and migrates automatically.
- Migration changes the session's `cwd` — its workspace ownership and disk storage location. This is the essence of "organizing into a workspace."
- The `zstd` CLI must be installed (auto-detected via PATH; no hardcoded path).

## License

[MIT](LICENSE)

---

<p align="center">
  <a href="https://github.com/lanscer/dsh-workspace-drag/blob/main/README.zh.md"><b>中文文档</b></a> · <a href="https://github.com/lanscer/dsh-workspace-drag">English</a>
</p>
