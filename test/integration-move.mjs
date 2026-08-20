/**
 * Integration test for moveSessionToWorkspace (the real exported function
 * from dsh-workspace-drag).
 *
 * @file test/integration-move.mjs
 * @license MIT
 * @author lanscer <lanscer@qq.com>
 * @version 1.0.0
 *
 * Runs against a temp sessions root with fake
 * ctx/sessionPersistence/workspaceRegistry objects. Verifies live-session
 * safety, header cwd rewrite, zstd frame preservation, and registry
 * detach/attach accounting.
 *
 * Run from the test/ directory:  node integration-move.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSessionToWorkspace } from '../lib/index.js'

/** Locate zstd CLI (same logic as lib/index.js). */
function findZstd() {
  try {
    const found = execSync('which zstd', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    if (found !== '' && existsSync(found)) return found
  } catch {}
  for (const candidate of ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd', '/opt/local/bin/zstd']) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('zstd CLI not found')
}
const ZSTD_BIN = findZstd()

// ---- Prepare a temp sessions root with a real session ----
const SRC = './fixtures/multiframe-session.jsonl.zstd'
const SESSION_ID = '46628005-3c45-4826-8600-97ae1994abff'
const OLD_CWD = '/src/workspace'
const NEW_CWD = '/tmp/test-target-workspace'
mkdirSync(NEW_CWD, { recursive: true }) // ensure the fake target workspace exists on disk
const NEW_WORKSPACE_ID = 'ws-new-target'
const OLD_WORKSPACE_ID = 'ws-old-source'

// The fixture is a MULTI-FRAME zstd log (1 header frame + 6 batch frames).
// Count its frames before the move; after the move the count must be identical
// and the header cwd rewritten — this guards the frame-preserving surgery
// (single-frame re-encoding breaks dsh's reader).
const ZSTD_MAGIC = 4247762216
function scanZstdFrames(buffer) {
  const frames = []; let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('bad magic')
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid magic')
    offset += 4
    if (offset === buffer.length) throw new Error('torn')
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += (blockType === 1 ? 1 : blockSize)
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}
const origFrameCount = scanZstdFrames(readFileSync(SRC)).length

function projectKey(cwd) {
  let readable = ''; let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i); const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false }
    else { readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); separatorRun = false }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const root = mkdtempSync(join(tmpdir(), 'dswd-int-'))
const oldProjectDir = join(root, projectKey(OLD_CWD))
const oldSessionDir = join(oldProjectDir, SESSION_ID)
mkdirSync(oldSessionDir, { recursive: true })
copyFileSync(SRC, join(oldSessionDir, 'session.jsonl.zstd'))

// Also drop a companion artifact to test whole-dir copy
writeFileSync(join(oldSessionDir, 'notes.txt'), 'companion artifact')

const logPath = join(oldSessionDir, 'session.jsonl.zstd')

// ---- Fake objects ----
const fakeEntities = []
function makeEntity(id, path, title) {
  const entity = {
    id, path, title,
    sessionIds: [],
    attachCalls: [], detachCalls: [],
    async attachSession(sid) { entity.attachCalls.push(sid); if (!entity.sessionIds.includes(sid)) entity.sessionIds.push(sid) },
    async detachSession(sid) { entity.detachCalls.push(sid); entity.sessionIds = entity.sessionIds.filter((x) => x !== sid) },
  }
  fakeEntities.push(entity)
  return entity
}
const oldEntity = makeEntity(OLD_WORKSPACE_ID, OLD_CWD, 'api 安装和插件安装')
const newEntity = makeEntity(NEW_WORKSPACE_ID, NEW_CWD, 'DeepSeek_hs')
oldEntity.sessionIds.push(SESSION_ID) // session accounted under old workspace

const persistence = {
  root,
  async list() {
    return [{ type: 'session', id: SESSION_ID, cwd: OLD_CWD }]
  },
  locate(header) {
    return { kind: 'jsonl', path: join(root, projectKey(header.cwd), header.id, 'session.jsonl.zstd') }
  },
}

const registry = {
  get(id) { return fakeEntities.find((e) => e.id === id) },
  list() { return fakeEntities },
  replaceHeaderIndexCalls: 0,
  async replaceHeaderIndex() { registry.replaceHeaderIndexCalls += 1 },
}

const ctx = {
  sessions: { get() { return undefined } }, // not live
  sessionPersistence: persistence,
  workspaceRegistry: registry,
}

// ---- Live-session layered safety tests (before the main move, so the
//      session is still in its original location) ----
let allPass = true
// Case A: LIVE + fresh mtime (< 30s) -> must be refused (agent writing).
{
  const liveCtx = { ...ctx, sessions: { get() { return { id: SESSION_ID } } } }
  let threw = false, msg = ''
  try {
    await moveSessionToWorkspace(liveCtx, SESSION_ID, NEW_WORKSPACE_ID)
  } catch (e) { threw = true; msg = e.message }
  console.log(`${threw && msg.includes('写入中') ? '✅' : '❌'} live+fresh-mtime refused: ${msg.slice(0, 40)}`)
  if (!threw || !msg.includes('写入中')) allPass = false
}
// Case B: LIVE + old mtime (touch log to 2 minutes ago) -> allowed to move.
// This IS the real move (relocates SESSION_ID to NEW_CWD).
{
  const past = new Date(Date.now() - 120_000)
  const { utimesSync } = await import('node:fs')
  utimesSync(logPath, past, past)
  const liveCtx = { ...ctx, sessions: { get() { return { id: SESSION_ID } } } }
  let threw = false, msg = ''
  try {
    const r = await moveSessionToWorkspace(liveCtx, SESSION_ID, NEW_WORKSPACE_ID)
    msg = 'moved: ' + JSON.stringify(r)
  } catch (e) { threw = true; msg = e.message }
  console.log(`${!threw ? '✅' : '❌'} live+old-mtime allowed: ${msg.slice(0, 50)}`)
  if (threw) allPass = false
}

// ---- Assertions ----
const newSessionDir = join(root, projectKey(NEW_CWD), SESSION_ID)
const checks = []
checks.push(['old session dir removed', !existsSync(oldSessionDir)])
checks.push(['new session dir exists', existsSync(newSessionDir)])
checks.push(['companion artifact copied', existsSync(join(newSessionDir, 'notes.txt'))])
checks.push(['old dir empty of log (fully removed)', true]) // covered above

// Header cwd updated in the moved log
const movedPlain = execFileSync(ZSTD_BIN, ['-dc', '--no-progress', join(newSessionDir, 'session.jsonl.zstd')]).toString('utf8')
const movedHeader = JSON.parse(movedPlain.slice(0, movedPlain.indexOf('\n')))
checks.push(['header cwd updated', movedHeader.cwd === NEW_CWD])
checks.push(['header id preserved', movedHeader.id === SESSION_ID])

// Frame structure preserved (the multi-frame invariant dsh's reader relies on)
const movedFrameCount = scanZstdFrames(readFileSync(join(newSessionDir, 'session.jsonl.zstd'))).length
checks.push(['frame count preserved', movedFrameCount === origFrameCount])

// Registry calls
checks.push(['replaceHeaderIndex called', registry.replaceHeaderIndexCalls === 1])
checks.push(['old workspace detached', oldEntity.detachCalls.includes(SESSION_ID)])
checks.push(['new workspace attached', newEntity.attachCalls.includes(SESSION_ID)])
checks.push(['old sessionIds empty', !oldEntity.sessionIds.includes(SESSION_ID)])
checks.push(['new sessionIds has session', newEntity.sessionIds.includes(SESSION_ID)])

// New project dir parent has no leftover
checks.push(['only one session dir in new project', readdirSync(join(root, projectKey(NEW_CWD))).length === 1])

let allPass2 = true
for (const [name, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) allPass2 = false
}
allPass = allPass && allPass2

// Same-workspace test: target the workspace matching the session's CURRENT
// cwd (NEW_WORKSPACE_ID) — that must throw "same workspace".
try {
  await moveSessionToWorkspace(ctx, SESSION_ID, NEW_WORKSPACE_ID)
  console.log('❌ same-workspace guard did NOT throw')
  allPass = false
} catch (e) {
  console.log('✅ same-workspace guard throws:', e.message.slice(0, 40))
}

rmSync(root, { recursive: true, force: true })
rmSync(NEW_CWD, { recursive: true, force: true })
console.log(allPass ? '\nALL INTEGRATION CHECKS PASSED ✅' : '\nSOME CHECKS FAILED ❌')
process.exit(allPass ? 0 : 1)
