/**
 * dsh-workspace-drag — host half (Node.js).
 *
 * @module dsh-workspace-drag/lib/index
 * @description Relocates a conversation (session) between dsh workspaces and
 *   persists the plugin's enable/disable toggle. Exposes the HTTP routes
 *   /api/dsh-workspace-drag/config and /api/dsh-workspace-drag/move.
 * @license MIT
 * @author lanscer <lanscer@qq.com>
 * @version 1.0.0
 * @see https://github.com/lanscer/dsh-workspace-drag
 *
 * WHY NOT the settings namespace: the official settings RPC exposes only a
 * hardcoded allowlist of namespaces, so a third-party namespace would answer
 * "settings-not-exposed". A dedicated config route + JSON file (the same
 * pattern dsh-complete-sound / dsh-ssh use) is the supported route.
 *
 * WHAT "move a conversation to a workspace" means at the data level:
 *   - Each session's workspace identity is its header `cwd` (an absolute
 *     directory path). The session is stored on disk at
 *     `~/.dsh/sessions/<projectKey(cwd)>/<session-id>/session.jsonl[.zstd]`.
 *   - Moving = physically relocating the session directory under the new
 *     workspace's project key AND rewriting the first (header) line's `cwd`.
 *   - The workspace registry (`ctx.workspaceRegistry`) keeps a durable
 *     `sessionIds` ownership account per workspace; we detach from the old
 *     workspace and attach to the new one so the sidebar reflects the move
 *     immediately (and stays consistent after a reload).
 *
 * SAFETY (layered):
 *   - Sessions with a FRESH write (an agent actively appending right now)
 *     are refused — moving them would split the log across old/new paths.
 *   - Open-but-idle live sessions ARE allowed: the move is a copy-verify-
 *     atomic-swap (never destroys data), and after the move the next append
 *     re-adopts from disk (new cwd) when the coordinator holds no cached
 *     state for the session.
 *
 * DEPENDENCIES:
 *   - zstd CLI (auto-detected via PATH search, no hardcoded path).
 *   - DSH host services: webServer / sessions / sessionPersistence /
 *     workspaceRegistry (all provided by @deepseek-ai/dsh-web-app).
 *
 * PLATFORMS: macOS and Linux.
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A live session whose log was written within this window is treated as
 * actively being appended (agent running) and is refused for relocation.
 * Idle live sessions (no write in this window) are safe to move.
 */
const LIVE_WRITE_WINDOW_MS = 30_000

/** Stable cordis plugin name. */
export const name = 'workspace-drag'

/** Services required before the routes can mount. */
export const inject = ['webServer', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/** Config route (GET read / POST patch). */
export const CONFIG_API_PATH = '/api/dsh-workspace-drag/config'

/** Move route (POST). */
export const MOVE_API_PATH = '/api/dsh-workspace-drag/move'

/** Default master switch. */
export const DEFAULT_ENABLED = true

/** Absolute path of the plugin's persisted config file. */
function configFilePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-workspace-drag.json')
}

/** Read the persisted config, falling back to defaults on any problem. */
function loadConfig() {
  try {
    const path = configFilePath()
    if (!existsSync(path)) return { enabled: DEFAULT_ENABLED }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { enabled: raw.enabled !== false }
  } catch {
    return { enabled: DEFAULT_ENABLED }
  }
}

/** Persist the config (best-effort; in-memory state keeps working on failure). */
function saveConfig(config) {
  try {
    const path = configFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  } catch (error) {
    console.warn('[dsh-workspace-drag] config save failed:', error)
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.byteLength
    if (size > 64 * 1024) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Session storage layout helpers (mirror of dsh-session-persistence-jsonl)
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe project directory name for a cwd, exactly like the
 * persistence backend's `projectKey`. `/ \ :` collapse to `-`, safe
 * [A-Za-z0-9._-] chars pass through, anything else becomes `~XXXX` hex,
 * wrapped in `--...--`.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Detect whether a session log path is zstd-compressed by suffix. */
function isZstdPath(path) {
  return path.endsWith('.zstd')
}

/**
 * Locate the zstd CLI binary. Searches PATH first (works on any platform),
 * then falls back to common absolute paths for environments where PATH may
 * not include the zstd installation directory.
 * @returns {string} absolute path to the zstd executable.
 */
function findZstd() {
  // 1. Search PATH (works on macOS, Linux, Windows with zstd in PATH).
  try {
    const found = execSync('which zstd', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    if (found !== '' && existsSync(found)) return found
  } catch { /* fall through to known paths */ }
  // 2. Common platform-specific paths.
  for (const candidate of [
    '/opt/homebrew/bin/zstd',   // macOS Apple Silicon Homebrew
    '/usr/local/bin/zstd',      // macOS Intel Homebrew / Linux local
    '/usr/bin/zstd',            // Linux package manager
    '/opt/local/bin/zstd',      // macOS MacPorts
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'zstd CLI not found. Install it with:\n' +
    '  macOS:  brew install zstd\n' +
    '  Linux:  apt install zstd  (or your package manager)'
  )
}

/** Resolved absolute path to the zstd CLI binary. */
const ZSTD_BIN = findZstd()

/** Run the zstd CLI synchronously, returning stdout bytes (binary-safe). */
function zstd(args, input) {
  // execFileSync handles input->stdin + stdout collection correctly (the
  // promisified execFile + input variant deadlocks with zstd). Sync is fine:
  // a move is a rare user action and session logs are small.
  return execFileSync(ZSTD_BIN, args, {
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  })
}

/**
 * Decompress a session log to plaintext JSONL. Handles both zstd and plain.
 * @returns {Buffer} the plaintext bytes (newline-terminated first line).
 */
function decodeLog(filePath) {
  if (!isZstdPath(filePath)) return readFileSync(filePath)
  return zstd(['-dc', '--no-progress', filePath])
}

/** Recompress plaintext JSONL to a zstd frame (checksummed, like the backend). */
function encodeLogZstd(plaintext) {
  return zstd(['-q', '-c', '--check', '--no-progress'], plaintext)
}

/** zstd frame magic, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = 4247762216

/**
 * Locate complete zstd frames in a concatenated-frame buffer (structural
 * scan — a replica of dsh-session-persistence-jsonl's scanner, verified
 * against dsh's own reader in test/verify-core.mjs). Returns
 * `{ frames: [{start,end}], tornStart }`; `tornStart` set when a trailing
 * incomplete frame is found (EOF inside it).
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) { if (buffer.length - offset < 4) return { frames, tornStart: start }; offset += 4 }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Frame-preserving header rewrite for a zstd session log. dsh stores the log
 * as concatenated zstd frames: frame 1 = the header line, frames 2..N = the
 * appended event batches. We therefore decode ONLY frame 1, rewrite its
 * header cwd, re-encode it as one checksummed frame, and concatenate it with
 * the untouched original frames 2..N (byte-identical). This keeps dsh's
 * reader happy ("first frame is exactly one header line") and never touches
 * the event data.
 *
 * @param rawFile - the full bytes of `session.jsonl.zstd`.
 * @param newCwd - the destination absolute path to stamp into the header.
 * @returns the full new file bytes.
 */
function rewriteZstdHeaderCwd(rawFile, newCwd) {
  const { frames, tornStart } = scanZstdFrames(rawFile)
  if (tornStart !== undefined) throw new Error('corrupt Zstandard session log: torn final frame')
  if (frames.length === 0) throw new Error('corrupt Zstandard session log: no frames')
  const firstFrame = rawFile.subarray(frames[0].start, frames[0].end)
  const headerPlain = zstd(['-dc', '--no-progress'], firstFrame)
  const rewritten = rewriteHeaderCwd(headerPlain, newCwd)
  const newFirstFrame = encodeLogZstd(rewritten)
  const rest = rawFile.subarray(frames[0].end)
  return Buffer.concat([newFirstFrame, rest])
}

/**
 * Rewrite the first (header) line of a JSONL session log, preserving every
 * other line byte-for-byte. Returns the new full text.
 */
function rewriteHeaderCwd(plaintext, newCwd) {
  const firstNl = plaintext.indexOf('\n')
  const head = firstNl === -1 ? plaintext : plaintext.slice(0, firstNl)
  // Preserve the rest verbatim; a header without a trailing newline gets one
  // (dsh's first frame is required to be exactly one newline-terminated line).
  const rest = firstNl === -1 ? Buffer.from('\n') : plaintext.slice(firstNl)
  let header
  try {
    header = JSON.parse(head.toString('utf8'))
  } catch (error) {
    throw new Error(`session log has an unparseable header line: ${error.message}`)
  }
  if (typeof header.cwd !== 'string') {
    throw new Error('session log header carries no cwd; cannot relocate')
  }
  header.cwd = newCwd
  const newHead = Buffer.from(JSON.stringify(header))
  return Buffer.concat([newHead, rest])
}

/**
 * Copy a directory tree (session-local artifacts + log) recursively.
 * Simple recursive copy — session dirs are small (a log + a few files).
 */
function copyDirTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dst = join(to, entry)
    const st = statSync(src)
    if (st.isDirectory()) copyDirTree(src, dst)
    else copyFileSync(src, dst)
  }
}

// ---------------------------------------------------------------------------
// Move implementation
// ---------------------------------------------------------------------------

/**
 * Relocate a non-live session to another workspace.
 *
 * @param ctx - host plugin context.
 * @param sessionId - the session to move.
 * @param targetWorkspaceId - the destination workspace registry id.
 * @returns a summary of what moved.
 */
async function moveSessionToWorkspace(ctx, sessionId, targetWorkspaceId) {
  const registry = ctx.workspaceRegistry
  const persistence = ctx.sessionPersistence

  // 1. Resolve the destination workspace.
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) throw new Error(`目标工作区不存在: ${targetWorkspaceId}`)
  const targetPath = target.path
  if (typeof targetPath !== 'string' || targetPath === '') throw new Error('目标工作区没有有效路径')
  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    throw new Error(`目标工作区目录不存在: ${targetPath}`)
  }

  // 3. Locate the session's stored header + on-disk artifact. Prefer the
  //    persistence backend; fall back to scanning the sessions root.
  let header = null
  let currentPath = null
  if (persistence && typeof persistence.list === 'function') {
    const headers = await persistence.list()
    header = headers.find((h) => h && h.id === sessionId) ?? null
    if (header && typeof persistence.locate === 'function') {
      try {
        const loc = persistence.locate(header)
        if (loc && typeof loc.path === 'string') currentPath = loc.path
      } catch { /* fall through to filesystem scan */ }
    }
  }

  // The sessions root (directory that contains `--<projectKey>--` dirs).
  let root = persistence && typeof persistence.root === 'string' ? persistence.root : null
  if (root === null) root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

  if (currentPath === null || !existsSync(currentPath)) {
    if (existsSync(root)) {
      for (const projectDirName of readdirSync(root)) {
        if (!projectDirName.startsWith('--')) continue
        const candidateDir = join(root, projectDirName, sessionId)
        if (!existsSync(candidateDir)) continue
        for (const file of readdirSync(candidateDir)) {
          if (file === 'session.jsonl' || file === 'session.jsonl.zstd') {
            currentPath = join(candidateDir, file)
            break
          }
        }
        if (currentPath !== null) break
      }
    }
  }
  if (currentPath === null || !existsSync(currentPath)) {
    throw new Error(`未找到对话 ${sessionId} 的存储文件`)
  }

  // 3b. Live-session safety: allow moving OPEN-but-IDLE sessions (the common
  //     organize-a-recent-conversation case), but refuse sessions whose log
  //     was written within LIVE_WRITE_WINDOW_MS — an agent actively appending
  //     right now would split the log across the old/new locations. Idle live
  //     sessions are safe: the move is a copy-verify-atomic-swap (never
  //     destroys data), and after the move the next append re-adopts from
  //     disk (new cwd) when the coordinator holds no cached state.
  const liveSessions = ctx.sessions
  const isLive = liveSessions && typeof liveSessions.get === 'function' && liveSessions.get(sessionId) !== undefined
  if (isLive) {
    try {
      const mtimeMs = statSync(currentPath).mtimeMs
      if (Number.isFinite(mtimeMs) && Date.now() - mtimeMs < LIVE_WRITE_WINDOW_MS) {
        throw new Error('该对话正在写入中（Agent 运行中或刚更新过），请稍后再移动')
      }
    } catch (error) {
      if (error && error.message && error.message.indexOf('正在写入中') !== -1) throw error
      // stat failed — treat as safe to move (unknown mtime).
    }
  }

  // 4. Determine old cwd (header wins; fall back to decoding the log).
  const oldPath = currentPath
  const oldSessionDir = dirname(oldPath)
  let oldCwd = typeof header?.cwd === 'string' ? header.cwd : null
  if (oldCwd === null) {
    const plaintext = decodeLog(oldPath)
    const firstNl = plaintext.indexOf('\n')
    const headLine = (firstNl === -1 ? plaintext : plaintext.slice(0, firstNl)).toString('utf8')
    try {
      oldCwd = JSON.parse(headLine).cwd ?? null
    } catch { /* leave null */ }
  }
  if (typeof oldCwd !== 'string' || oldCwd === '') throw new Error('无法确定对话当前所在工作区')

  // 5. Compute the destination directory inside the session tree.
  const newProjectDir = join(root, projectKey(targetPath))
  const newSessionDir = join(newProjectDir, basename(oldSessionDir))
  if (newSessionDir === oldSessionDir) {
    throw new Error('目标工作区与当前工作区相同')
  }

  // 6. Rewrite the header cwd. For zstd logs this is a FRAME-PRESERVING
  //    surgery (decode frame 1, rewrite header, re-encode frame 1, keep
  //    frames 2..N byte-identical) — dsh requires the first frame to contain
  //    exactly the header line. For plain logs it's a plaintext splice.
  const oldSuffix = oldPath.endsWith('.zstd') ? '.zstd' : ''
  let rewritten
  if (oldSuffix === '.zstd') {
    rewritten = rewriteZstdHeaderCwd(readFileSync(oldPath), targetPath)
  } else {
    rewritten = rewriteHeaderCwd(decodeLog(oldPath), targetPath)
  }

  // 7. Stage the moved copy: copy the whole session dir to a temp dir,
  //    swap in the rewritten log, verify, then publish into the new project
  //    dir. The old dir is removed only after the new copy is verified.
  const staging = mkdtempSync(join(tmpdir(), 'dsh-workspace-drag-'))
  const logFileName = 'session.jsonl' + (oldSuffix === '.zstd' ? '.zstd' : '')
  try {
    copyDirTree(oldSessionDir, staging)
    const stagedLog = join(staging, logFileName)
    if (existsSync(stagedLog)) rmSync(stagedLog)
    writeFileSync(stagedLog, rewritten)

    // Verify the rewritten header parses back to the target cwd.
    const verifyText = decodeLog(stagedLog)
    const verifyHead = JSON.parse(verifyText.slice(0, verifyText.indexOf('\n')).toString('utf8'))
    if (verifyHead.cwd !== targetPath || verifyHead.id !== sessionId) {
      throw new Error(`迁移后校验失败: header cwd=${verifyHead.cwd}, id=${verifyHead.id}`)
    }

    // Publish into the session tree (copy; portable across mounts).
    mkdirSync(newProjectDir, { recursive: true })
    if (existsSync(newSessionDir)) rmSync(newSessionDir, { recursive: true, force: true })
    copyDirTree(staging, newSessionDir)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // 8. Remove the old session directory now that the new copy is verified.
  rmSync(oldSessionDir, { recursive: true, force: true })

  // 9. Refresh the registry header index so the moved cwd is authoritative,
  //    then move the session's ownership account: detach old / attach new.
  if (registry && typeof registry.replaceHeaderIndex === 'function') {
    await registry.replaceHeaderIndex(await persistence.list())
  }
  // Detach from the workspace whose path matched the old cwd (may be none —
  // the session may have lived in the ungrouped bucket).
  if (registry && typeof registry.list === 'function') {
    for (const entity of registry.list()) {
      if (entity && entity.path === oldCwd && entity.id !== target.id) {
        if (typeof entity.detachSession === 'function') await entity.detachSession(sessionId)
        break
      }
    }
  }
  // Attach to the new workspace (validates cwd === workspace path — now true).
  if (typeof target.attachSession === 'function') {
    await target.attachSession(sessionId)
  }

  return {
    ok: true,
    sessionId,
    from: oldCwd,
    to: targetPath,
    workspaceId: targetWorkspaceId,
  }
}

/**
 * Mount the config and move routes.
 */
export function apply(ctx) {
  let current = loadConfig()

  const patchConfig = (patch) => {
    if (typeof patch === 'object' && patch !== null) {
      current = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled }
    }
    saveConfig(current)
    return current
  }

  // Config route: GET reads, POST patches.
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_API_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          writeJson(res, 200, current)
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          writeJson(res, 200, patchConfig(body))
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      },
    })
    return () => { dispose() }
  }, 'workspace-drag: config route')

  // Move route: POST { sessionId, targetWorkspaceId }.
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: MOVE_API_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        if (!current.enabled) {
          writeJson(res, 403, { error: '拖拽归类功能已关闭，请在设置中启用后再使用' })
          return
        }
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId : ''
        if (sessionId === '') { writeJson(res, 400, { error: 'missing sessionId' }); return }
        if (targetWorkspaceId === '') { writeJson(res, 400, { error: 'missing targetWorkspaceId' }); return }
        try {
          const result = await moveSessionToWorkspace(ctx, sessionId, targetWorkspaceId)
          writeJson(res, 200, result)
        } catch (error) {
          console.warn('[dsh-workspace-drag] move failed:', error?.message || error)
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    return () => { dispose() }
  }, 'workspace-drag: move route')
}

// Exported for testing/inspection. The runtime entry point is `apply`.
export { moveSessionToWorkspace }
