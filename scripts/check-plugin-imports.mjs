#!/usr/bin/env node
/**
 * Import every platform plugin from a profile directory and fail on a
 * resolution error.
 *
 * Why this exists: a DSH profile installs with `autoInstallPeers: false`, so a
 * package that a plugin imports at RUNTIME must be present in the profile's
 * node_modules even when the plugin declares it only as a peerDependency.
 * `dsh --profile <name> --dump-config` does NOT catch the gap — it composes the
 * configuration without importing plugin bodies — so a missing runtime peer
 * ships as an image that boots into a half-dead tree (the plugin's fiber never
 * activates). This check imports each plugin exactly the way the loader does.
 *
 * Usage: node scripts/check-plugin-imports.mjs <profile-dir> [plugin ...]
 *   default plugins: the platform's own packages (the ones installed by file:)
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const profileDir = resolve(process.argv[2] ?? process.cwd())
const explicit = process.argv.slice(3)

/** Platform plugins installed into every web/headless profile. */
const DEFAULT_PLUGINS = [
  '@visecy/dsh-logging-stdout',
  '@visecy/dsh-fs-k8s',
  '@visecy/dsh-subprocess-k8s',
  '@visecy/dsh-workspace-k8s',
  '@visecy/dsh-session-persistence-rdb',
  '@visecy/dsh-storage-db',
  '@visecy/dsh-platform-domain',
]
/** Only the web profile installs these. */
const WEB_ONLY = ['@visecy/dsh-workspace-picker', '@visecy/dsh-identity-bridge']

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`check-plugin-imports: no package.json under ${profileDir}`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const installed = new Set(Object.keys(manifest.dependencies ?? {}))
const wanted = explicit.length > 0
  ? explicit
  : [...DEFAULT_PLUGINS, ...WEB_ONLY].filter((name) => installed.has(name))

const require = createRequire(manifestPath)
const failures = []
for (const name of wanted) {
  try {
    await import(require.resolve(name))
    console.log(`ok   ${name}`)
  } catch (error) {
    const code = error?.code ?? 'ERROR'
    const message = String(error?.message ?? error).split('\n')[0]
    console.error(`FAIL ${name}: ${code} ${message}`)
    failures.push(name)
  }
}

if (failures.length > 0) {
  console.error(`\ncheck-plugin-imports: ${failures.length} plugin(s) cannot load: ${failures.join(', ')}`)
  console.error('Add the missing packages to the profile install (see docker/dsh-web-platform.Dockerfile).')
  process.exit(1)
}
console.log(`\ncheck-plugin-imports: all ${wanted.length} plugins import cleanly from ${profileDir}`)
