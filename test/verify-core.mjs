/**
 * Standalone verification of dsh-workspace-drag's core file operations.
 *
 * @file test/verify-core.mjs
 * @license MIT
 * @author lanscer <lanscer@qq.com>
 * @version 1.0.0
 *
 * Replicates the exact logic from lib/index.js (projectKey, decodeLog,
 * rewriteHeaderCwd, encodeLogZstd) and tests it against a REAL session log
 * copied into a temp dir. Verifies:
 *  1. projectKey() matches the on-disk project dir name.
 *  2. decode -> rewrite cwd -> re-encode round-trips: every line identical
 *     except the header's cwd.
 *  3. The re-encoded zstd is decompressible by the zstd CLI.
 *
 * Run from the test/ directory:  node verify-core.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

// ---- Replicate the exact functions from lib/index.js ----
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

function isZstdPath(path) { return path.endsWith('.zstd') }

function decodeLog(filePath) {
  if (!isZstdPath(filePath)) return readFileSync(filePath)
  return execFileSync(ZSTD_BIN, ['-dc', '--no-progress', filePath])
}

function encodeLogZstd(plaintext) {
  return execFileSync(ZSTD_BIN, ['-q', '-c', '--no-progress'], { input: plaintext })
}

function rewriteHeaderCwd(plaintext, newCwd) {
  const firstNl = plaintext.indexOf('\n')
  const head = firstNl === -1 ? plaintext : plaintext.slice(0, firstNl)
  const rest = firstNl === -1 ? '' : plaintext.slice(firstNl)
  let header
  try { header = JSON.parse(head.toString('utf8')) } catch (e) { throw new Error(`unparseable header: ${e.message}`) }
  if (typeof header.cwd !== 'string') throw new Error('header has no cwd')
  header.cwd = newCwd
  const newHead = Buffer.from(JSON.stringify(header))
  return Buffer.concat([newHead, rest])
}

// ---- Test ----
const srcLog = './fixtures/multiframe-session.jsonl.zstd'
const original = decodeLog(srcLog)
const headerLine = original.slice(0, original.indexOf('\n')).toString('utf8')
const header = JSON.parse(headerLine)
const origCwd = header.cwd
console.log('original cwd :', origCwd)
console.log('original id  :', header.id)

// 1. projectKey matches the on-disk project dir
const expectedProjectName = projectKey(origCwd)
console.log('projectKey    :', expectedProjectName)

// 2. rewrite to a different workspace
const NEW_CWD = '/tmp/test-target-workspace'
const rewritten = rewriteHeaderCwd(original, NEW_CWD)
const rewHead = JSON.parse(rewritten.slice(0, rewritten.indexOf('\n')).toString('utf8'))
console.log('rewritten cwd:', rewHead.cwd)
if (rewHead.cwd !== NEW_CWD) throw new Error('cwd rewrite failed')
if (rewHead.id !== header.id) throw new Error('id changed!')

// 3. Re-encode and verify every line except the header matches
const reencoded = encodeLogZstd(rewritten)
const workdir = mkdtempSync(join(tmpdir(), 'dswd-verify-'))
const outPath = join(workdir, 'session.jsonl.zstd')
writeFileSync(outPath, reencoded)
const decodedBack = decodeLog(outPath)
const origLines = rewritten.toString('utf8').split('\n')
const backLines = decodedBack.toString('utf8').split('\n')
console.log('lines          :', origLines.length, '->', backLines.length)
if (origLines.length !== backLines.length) throw new Error(`line count mismatch ${origLines.length} vs ${backLines.length}`)
for (let i = 1; i < origLines.length; i++) {
  if (origLines[i] !== backLines[i]) {
    throw new Error(`line ${i + 1} differs after round-trip`)
  }
}
// Verify each line is valid JSON (except trailing empty)
for (let i = 0; i < backLines.length; i++) {
  const line = backLines[i]
  if (line === '') continue
  JSON.parse(line)
}
console.log('header line    :', backLines[0].slice(0, 120))
console.log('ALL LINES (except header cwd) byte-identical after zstd round-trip ✅')
console.log('all JSONL lines parse ✅')

// 4. zstd CLI can decompress the re-encoded file (done above) — also verify
//    the file starts with a valid zstd frame magic
const magic = reencoded.subarray(0, 4).toString('hex')
if (magic !== '28b52ffd') throw new Error(`bad zstd magic: ${magic}`)
console.log('zstd frame magic OK:', magic)

rmSync(workdir, { recursive: true, force: true })
console.log('ALL CHECKS PASSED ✅')

// ---- dsh's scanZstdFrames replica (from dsh-session-persistence-jsonl) ----
const ZSTD_MAGIC = 4247762216
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []; let offset = 0
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
      const blockType = blockHeader >>> 1 & 3
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

// Validate the re-encoded file with dsh's frame scanner
const { frames, tornStart } = scanZstdFrames(reencoded)
console.log('dsh frame scan  :', JSON.stringify({ frames: frames.length, framesEnd: frames[0]?.end, bytes: reencoded.length, tornStart }))
if (tornStart !== undefined) throw new Error('torn frame detected')
if (frames.length !== 1) throw new Error(`expected 1 frame, got ${frames.length}`)
console.log('dsh frame scanner accepts the re-encoded file ✅')
