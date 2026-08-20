#!/usr/bin/env node
/**
 * dsh-workspace-drag — cross-platform one-command installer (Node.js).
 *
 * @module install-plugin.mjs
 * @license MIT
 * @author lanscer <lanscer@qq.com>
 * @version 1.0.0
 *
 * Registers this plugin into the DSH web profile:
 *   1) adds a `link:` dependency to <profile>/package.json
 *   2) creates a symlink at <profile>/node_modules/<name>
 *
 * WHY not `dsh plugin add` / `pnpm install`:
 *   pnpm's minimumReleaseAge policy rejects dependencies published within the
 *   last 24h (the web-ui-all dependency tree currently trips it). This script
 *   only edits package.json + creates the symlink, so it never triggers
 *   pnpm install and sidesteps that policy.
 *
 * WHY Node.js (not bash / PowerShell):
 *   Runs identically on Windows, macOS and Linux. Node >= 18 is a hard
 *   requirement of DSH anyway. Use `npm run install:plugin` from this
 *   plugin's directory (the directory that contains package.json).
 *
 * Idempotent: re-running when already registered is a no-op.
 *
 * Usage:
 *   npm run install:plugin
 *   node install-plugin.mjs [--profile web]
 */

import { mkdirSync, readFileSync, symlinkSync, existsSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-workspace-drag'
// Forward slashes are safest for pnpm's `link:` spec on every platform.
const PLUGIN_SRC = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '').replace(/\\/g, '/')

// ---- CLI: --profile <name> -------------------------------------------------
const argProfile = process.argv.indexOf('--profile')
const PROFILE = argProfile !== -1 && process.argv[argProfile + 1] ? process.argv[argProfile + 1] : 'web'

// ---- DSH profile path (DSH_HOME ?? ~/.dsh) ---------------------------------
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(dshHome, 'profiles', PROFILE)
const PKG_JSON = join(PROFILE_DIR, 'package.json')
const NM_DIR = join(PROFILE_DIR, 'node_modules')
const NM_LINK = join(NM_DIR, PLUGIN_NAME)

function log(msg) { console.log(msg) }
function warn(msg) { console.warn(msg) }

// ---- Preflight --------------------------------------------------------------
if (!existsSync(PKG_JSON)) {
  console.error(`error: profile package.json not found: ${PKG_JSON}`)
  console.error(`       confirm the DSH "${PROFILE}" profile exists (default ${join(homedir(), '.dsh', 'profiles', 'web')})`)
  process.exit(1)
}

// ---- Check whether already registered (idempotent) --------------------------
function readProfile() {
  return JSON.parse(readFileSync(PKG_JSON, 'utf8'))
}
function alreadyRegistered() {
  try {
    return Object.prototype.hasOwnProperty.call(readProfile().dependencies ?? {}, PLUGIN_NAME)
  } catch { return false }
}

if (alreadyRegistered() && existsSync(NM_LINK)) {
  log(`ℹ️  Plugin already registered: ${PLUGIN_NAME} -> ${PLUGIN_SRC}`)
  log(`   Present in ${PKG_JSON} and ${NM_LINK}, skipping install.`)
  log(`   To re-link: remove ${NM_LINK} and run "npm run install:plugin" again.`)
  process.exit(0)
}

// ---- Backup + write the link: dependency ------------------------------------
const backupPath = `${PKG_JSON}.bak-install-plugin-${Date.now()}`
try { copyFileSync(PKG_JSON, backupPath) } catch { /* best effort */ }

const profile = readProfile()
profile.dependencies = profile.dependencies ?? {}
profile.dependencies[PLUGIN_NAME] = `link:${PLUGIN_SRC}`
writeFileSync(PKG_JSON, JSON.stringify(profile, null, 2) + '\n', 'utf8')
log(`✅ Wrote ${PKG_JSON} : ${PLUGIN_NAME} -> link:${PLUGIN_SRC}`)

// ---- Create the node_modules symlink ----------------------------------------
mkdirSync(NM_DIR, { recursive: true })
try {
  if (existsSync(NM_LINK)) rmSync(NM_LINK, { recursive: true, force: true })
  symlinkSync(PLUGIN_SRC, NM_LINK, 'junction') // 'junction' works on Windows without admin/dev-mode
  log(`✅ Created symlink: ${NM_LINK} -> ${PLUGIN_SRC}`)
} catch (error) {
  warn(`⚠️  Failed to create symlink at ${NM_LINK}: ${error.message}`)
  warn('   On Windows, symlinks may require Developer Mode or running as Administrator.')
  warn(`   The package.json dependency was still written — run "dsh plugin --profile ${PROFILE} add link:${PLUGIN_SRC}" or fix the symlink manually.`)
}

// ---- Best-effort lockfile sync (macOS/Linux only) ---------------------------
if (process.platform !== 'win32') {
  const syncScript = join(homedir(), 'Documents', 'dsh-plugins', 'scripts', 'sync-profile-lockfile.py')
  if (existsSync(syncScript)) {
    // Only informational; failures are non-fatal.
    log('ℹ️  (macOS/Linux) lockfile sync via sync-profile-lockfile.py skipped here — run it manually if available.')
  }
}

log('')
log('Install complete. To activate:')
log('  - Client-only changes: refresh the browser page.')
log('  - Host changes: restart dsh web.')
