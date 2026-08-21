#!/usr/bin/env node
/**
 * patch-dsh.mjs — declarative patches for the official @deepseek-ai/dsh
 * install (node_modules). Replaces fragile sed one-liners with exact
 * old→new string replacements, each with a post-condition assertion and a
 * syntax check. Any mismatch fails the build loudly instead of silently
 * corrupting a bundle (the v0.1.12 incident).
 *
 * Usage: node scripts/patch-dsh.mjs [@deepseek-ai-dir]
 *   default: <repo>/node_modules/@deepseek-ai  (local dev layout)
 *   image:   /usr/local/lib/node_modules/@deepseek-ai
 *
 * Why patches and not plugins: the touched files are compiled artifacts of
 * official packages (the browser client bundle is loaded by package name;
 * the privileged RPC fence lives inside dsh-host-apiproxy's internal
 * closure). The platform's real extension points are cordis plugins — these
 * two patches only relax official loopback pins in a deployment where the
 * OIDC gate (dsh-auth-oidc) authenticates every request first.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const read = (p) => readFileSync(p, 'utf8')
const write = (p, s) => writeFileSync(p, s)

/** One patch: file (relative to base), exact old/new, assertion regex+count, optional keep-guard. */
const patches = [
  {
    file: join(base, 'dsh-client-connection', 'lib', 'index.js'),
    what: 'privileged RPC fence: trust configured trustedHosts (OIDC-gated deployment)',
    old: 'if (method !== void 0 && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, [])) return new Response("forbidden", { status: 403 });',
    new: 'if (method !== void 0 && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)) return new Response("forbidden", { status: 403 });',
    assert: /PRIVILEGED_METHODS\.has\(method\) && !isTrustedApiRequest\(request, trustedHosts\)/,
    assertCount: 1,
    // the interceptor path (authority === "loopback") MUST stay pinned:
    keep: /interceptor\.options\.authority === "loopback" && !isTrustedApiRequest\(request, \[\]\)/,
  },
  {
    file: join(base, 'dsh-client-connection', 'lib', 'client.js'),
    what: 'browser isLoopback: remote browser treated as trusted (host fence + OIDC gate still enforce)',
    old: 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
    new: 'isLoopback: true,',
    assert: /isLoopback: true,/,
    assertCount: 1,
  },
]

let failed = false
for (const patch of patches) {
  let source
  try {
    source = read(patch.file)
  } catch (error) {
    console.error(`[patch-dsh] FAIL cannot read ${patch.file}: ${error.message}`)
    failed = true
    continue
  }
  if (!source.includes(patch.old)) {
    console.error(`[patch-dsh] FAIL old fragment not found in ${patch.file} (${patch.what})`)
    failed = true
    continue
  }
  const patched = source.replace(patch.old, patch.new)
  if (!patch.assert.test(patched)) {
    console.error(`[patch-dsh] FAIL assertion missing in ${patch.file} (${patch.what})`)
    failed = true
    continue
  }
  const count = (patched.match(patch.assert) ?? []).length
  if (count !== patch.assertCount) {
    console.error(`[patch-dsh] FAIL assertion count ${count} != ${patch.assertCount} in ${patch.file}`)
    failed = true
    continue
  }
  if (patch.keep && !patch.keep.test(patched)) {
    console.error(`[patch-dsh] FAIL keep-guard missing in ${patch.file} (${patch.what})`)
    failed = true
    continue
  }
  // syntax gate: a bundle that does not parse would brick the web UI
  const check = spawnSync(process.execPath, ['--check', patch.file], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error(`[patch-dsh] FAIL syntax check for ${patch.file}: ${check.stderr}`)
    failed = true
    continue
  }
  write(patch.file, patched)
  console.log(`[patch-dsh] ok ${patch.what}`)
}
if (failed) {
  console.error('[patch-dsh] build aborted: one or more patches failed')
  process.exit(1)
}
console.log('[patch-dsh] all patches applied and syntax-checked')