#!/usr/bin/env node
/**
 * Drift guard for the vendored webserver fork.
 *
 * `vendor/dsh-web-auth/lib/webserver.js` is a fork of the official
 * `@deepseek-ai/dsh-host-webserver` that ADDS the request-gate extension
 * (registerGate + the pre-dispatch and pre-upgrade gate calls + the raw-socket
 * denial adapter). Upstream has no middleware hook, so the fork is the only way
 * to authenticate before route matching.
 *
 * The fork is therefore a copy, and the risk is silent drift: a future DSH
 * release edits the webserver, the fork keeps the old code, and the deployment
 * quietly loses the fix. This check makes that loud by asserting the invariant
 * the fork was built on:
 *
 *     every line of the installed official file still exists in the fork
 *
 * The extension only ADDS lines and rewrites imports, so a genuine upstream
 * change (added, removed or edited line) fails this check and forces a
 * re-sync at upgrade time. ALLOWED_REWRITES lists the few lines the fork
 * intentionally replaces; keep it as small as possible.
 *
 * Usage: node scripts/check-webserver-fork.mjs <dir-containing-@deepseek-ai>
 *   image: /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Official lines the fork is allowed to replace (must stay tiny and explicit). */
const ALLOWED_REWRITES = new Set([
  // the fork also imports STATUS_CODES for the upgrade-denial adapter
  'import { createServer } from "node:http";',
])

const here = dirname(fileURLToPath(import.meta.url))
const forkPath = resolve(here, '..', 'vendor', 'dsh-web-auth', 'lib', 'webserver.js')
const base = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const officialPath = join(base, 'dsh-host-webserver', 'lib', 'index.js')

const norm = (text) => text.split('\n').map((line) => line.trimEnd())
const fork = norm(readFileSync(forkPath, 'utf8'))
const official = norm(readFileSync(officialPath, 'utf8'))

// Multiset membership: an upstream line keeps its duplicate count, so a
// removed duplicate is caught too.
const counts = new Map()
for (const line of fork) counts.set(line, (counts.get(line) ?? 0) + 1)

const missing = []
for (const line of official) {
  const left = counts.get(line) ?? 0
  if (left === 0) {
    if (!ALLOWED_REWRITES.has(line.trim())) missing.push(line)
    continue
  }
  counts.set(line, left - 1)
}

if (missing.length > 0) {
  console.error(`check-webserver-fork: the fork is behind ${officialPath}`)
  console.error(`  ${missing.length} official line(s) are absent from ${forkPath}:`)
  for (const line of missing.slice(0, 20)) console.error(`    ${line.trim().slice(0, 120)}`)
  if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`)
  console.error('\nRe-sync the fork with the new official file (keep the registerGate extension).')
  process.exit(1)
}

const added = fork.length - official.length + ALLOWED_REWRITES.size
console.log(`check-webserver-fork: ok — every official line is present in the fork (extension adds ~${added} lines)`)
