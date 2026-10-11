#!/usr/bin/env node
/**
 * Manifest/tarball consistency check for every package that WOULD be published.
 *
 * Why this exists: the five npm packages declared `types: dist/index.d.ts` while
 * the build only ever emitted `dist/index.js`. Nothing caught it -- not the
 * build, not the tests, not `npm pack` -- so every consumer of the published
 * package got a dangling types path. This walks `main` / `types` / `exports`,
 * packs the package the way the release does (`npm pack --dry-run --json`,
 * offline), and fails when a promised file is not actually in the tarball.
 *
 * It is deliberately NOT the full publint/attw check: those need network
 * installs and check the resolution against other consumers. This is the subset
 * that can run in CI and locally with nothing but npm.
 *
 * Usage: node scripts/check-package-manifests.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

/** Every file path a manifest promises to a consumer, as `[field, relativePath]`. */
function promisedFiles(manifest) {
  const promised = []
  if (typeof manifest.main === 'string') promised.push(['main', manifest.main])
  if (typeof manifest.types === 'string') promised.push(['types', manifest.types])
  if (typeof manifest.module === 'string') promised.push(['module', manifest.module])

  const walk = (value, field) => {
    if (typeof value === 'string') {
      promised.push([field, value])
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, `${field}.${key}`)
    }
  }
  walk(manifest.exports, 'exports')
  // `./package.json` is always packed by npm; keep it out of the noise.
  return promised.filter(([, rel]) => rel !== './package.json' && rel !== 'package.json')
}

/** Files the release would actually put in the tarball (`pnpm pack` == what `pnpm publish` ships). */
function packedFiles(dir) {
  const json = execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(json)
  const files = (Array.isArray(parsed) ? parsed[0]?.files : parsed.files) ?? []
  return new Set(files.map((file) => file.path))
}

let failures = 0
let checked = 0

for (const entry of readdirSync(packagesDir).sort()) {
  const dir = join(packagesDir, entry)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.private === true) continue
  checked += 1

  const promised = promisedFiles(manifest)

  // 1. the path must exist on disk (after a build)
  const missingOnDisk = promised.filter(([, rel]) => !existsSync(join(dir, rel.replace(/^\.\//, ''))))
  for (const [field, rel] of missingOnDisk) {
    console.error(`FAIL ${manifest.name}: ${field} -> ${rel} does not exist (did the build run?)`)
    failures += 1
  }
  if (missingOnDisk.length > 0) continue

  // 2. and it must be in the tarball a consumer would get (`files` / npm defaults)
  const packed = packedFiles(dir)
  for (const [field, rel] of promised) {
    const path = rel.replace(/^\.\//, '')
    if (!packed.has(path)) {
      console.error(`FAIL ${manifest.name}: ${field} -> ${rel} is promised but NOT packed (check "files")`)
      failures += 1
    }
  }
  if (failures === 0) console.log(`ok   ${manifest.name}`)
}

if (checked === 0) {
  console.error('FAIL: no publishable package found under packages/')
  process.exit(1)
}
console.log(failures === 0
  ? `manifest check OK (${checked} publishable package(s))`
  : `manifest check FAILED: ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
