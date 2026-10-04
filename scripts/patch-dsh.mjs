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
 * the Host/Origin fence and the browser-session cookie layer live inside
 * dsh-client-connection's internal closure). The platform's real extension
 * points are cordis plugins — these patches only relax official browser
 * trust pins in a deployment where the OIDC gate (dsh-auth-oidc)
 * authenticates every request first.
 *
 * DSH 0.1.5-rc.1 delta vs the 0.1.2-rc.1 fragments: NONE — both fragments are
 * byte-stable across the jump and are kept verbatim.
 *  - the "privileged RPC fence" is still gone (0.1.2 removed the
 *    PRIVILEGED_METHODS loopback tier and replaced it with one uniform fence:
 *    a Host/Origin check against config `trustedHosts` → 403 on every /api
 *    request, RPC channel and WebSocket upgrade). `trustedHosts` remains
 *    official configuration (`dsh web --trusted-host` → webRuntime →
 *    connection row config), so the platform configures it in
 *    docker/profiles/web.cordis.patch.yml instead of patching compiled code.
 *    Note: entries must be bare `host[:port]` authorities — assertTrustedAuthority
 *    rejects schemes, paths and whitespace at plugin load.
 *  - the browser-session layer is unchanged: every request must also present
 *    an authority-bound signed cookie minted from a per-process launch token
 *    (BrowserAuth). Remote browsers behind the platform's OIDC gate can never
 *    redeem that token (the gate 302s the tokenized URL to the IdP, which
 *    drops the query), so this cookie layer is bypassed — the OIDC gate
 *    remains the sole session layer while the Host/Origin fence stays active
 *    as defense in depth.
 *  - the browser-side `isLoopback` classification is unchanged (it consults
 *    the shell transport's `ownsHost`); the platform still forces `true` so
 *    remote browsers keep host-backed settings persistence, the host document
 *    store and produced-file open affordances.
 *  - 0.1.5 added one boot global the fork must deliver
 *    (`__DSH_CONNECTION_RECOVERY__`, index-injected by dsh-client-connection);
 *    `dsh-host-webserver` is byte-identical, so the vendored fork already
 *    renders `kind: "global"` rows. The second patch's keep-guard asserts the
 *    injection site still exists so a future removal fails the build loudly.
 *  - 0.1.5 made `webServer` an OPTIONAL inject for dsh-client-connection and
 *    dsh-client-modules: if the forked webserver fails to load, DSH now boots
 *    without `/api` and without the `/plugins` bundle route instead of failing
 *    loudly. scripts/verify-profile.mjs asserts both routes after boot.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const read = (p) => readFileSync(p, 'utf8')
const write = (p, s) => writeFileSync(p, s)

const L = '\n' // patched artifacts use \n line endings; fragments build with explicit escapes.

/** One patch: file (relative to base), exact old/new, assertion regex+count, optional keep-guard. */
const patches = [
  {
    file: join(base, 'dsh-client-connection', 'lib', 'client.js'),
    what: 'browser isLoopback: remote browser treated as trusted (host fence + OIDC gate still enforce)',
    old: '\t\t\t\tisLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
    new: '\t\t\t\tisLoopback: true,',
    assert: /isLoopback: true,/,
    assertCount: 1,
    // the transport/ownsHost machinery must still exist for other consumers:
    keep: /globalThis\.__DSH_TRANSPORT__/,
  },
  {
    file: join(base, 'dsh-client-connection', 'lib', 'index.js'),
    what: 'browser-session cookie layer bypassed (OIDC gate authenticates every request; remote browsers cannot redeem the per-process launch token)',
    old: '\tisAuthenticated(request) {' + L +
      '\t\tconst authority = requestAuthority(request.headers);' + L +
      '\t\tconst rawCookie = header(request.headers, "cookie");' + L +
      '\t\tif (authority === void 0 || rawCookie === void 0) return false;' + L +
      '\t\tconst value = cookieValue(rawCookie, cookieName(authority));' + L +
      '\t\tif (value === void 0) return false;' + L +
      '\t\tconst payload = decodeCookie(value, this.secret);' + L +
      '\t\tif (payload === void 0 || payload.authority !== authority) return false;' + L +
      '\t\tconst now = Date.now();' + L +
      '\t\treturn payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds;' + L +
      '\t}',
    new: '\tisAuthenticated(request) {' + L +
      '\t\t// Platform patch: the OIDC gate in front of the webserver is the' + L +
      '\t\t// session layer; the dsh launch-token cookie flow cannot run behind it.' + L +
      '\t\treturn true;' + L +
      '\t}',
    assert: /isAuthenticated\(request\) \{\n\t\t\/\/ Platform patch: the OIDC gate in front of the webserver is the/,
    assertCount: 1,
    // the Host/Origin fence and the rest of the BrowserAuth machinery stay:
    keep: /!isTrustedApiRequest\(request, this\.trustedHosts\)/,
    // 0.1.5 ships connection recovery timing to the page through this
    // index-injection global; the vendored webserver fork renders kind:"global"
    // rows, so its disappearance would silently drop operator recovery config:
    keepAll: [/__DSH_CONNECTION_RECOVERY__/],
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
  const keepAll = patch.keepAll ?? []
  const missingKeep = keepAll.find((guard) => !guard.test(patched))
  if (missingKeep !== undefined) {
    console.error(`[patch-dsh] FAIL keep-guard ${missingKeep} missing in ${patch.file} (${patch.what})`)
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
