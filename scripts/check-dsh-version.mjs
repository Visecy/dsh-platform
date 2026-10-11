#!/usr/bin/env node
/**
 * One DSH version, stated in one place per artifact -- and they must agree.
 *
 * The preview audit found the platform's DSH baseline written four different
 * ways (README 0.1.5-rc.1, Dockerfile + release workflow 0.2.0-rc.2, deploy docs
 * 0.1.2-rc.1, and a `minimumReleaseAgeExclude` list still on 0.1.5-rc.1), so
 * "which DSH does this commit target?" had no answer from the repository alone.
 *
 * This asserts the three machine-readable places that MUST move together:
 *   1. the `@deepseek-ai/dsh-*` dependency pins in each package's package.json
 *   2. docker/dsh-web-platform.Dockerfile's `ARG DSH_VERSION=...`
 *   3. .github/workflows/release.yml's `DSH_VERSION` build-arg
 * and that the README's compatibility matrix names the same version.
 *
 * Usage: node scripts/check-dsh-version.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

// 1. dependency pins: every exact `@deepseek-ai/dsh*` version in the workspace.
const pinned = new Map()
for (const entry of readdirSync(join(root, 'packages')).sort()) {
  let manifest
  try {
    manifest = JSON.parse(read(join('packages', entry, 'package.json')))
  } catch {
    continue
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      if (typeof spec !== 'string' || /^[\^~]|workspace:|\*/.test(spec)) continue
      if (!pinned.has(spec)) pinned.set(spec, [])
      pinned.get(spec).push(`${manifest.name}:${field}.${name}`)
    }
  }
}
if (pinned.size === 0) problems.push('no exact @deepseek-ai/dsh dependency pin found in packages/*/package.json')
if (pinned.size > 1) {
  for (const [version, who] of pinned) problems.push(`dependency pins disagree: ${version} (${who.slice(0, 3).join(', ')}${who.length > 3 ? ', …' : ''})`)
}
const dependencyVersion = [...pinned.keys()][0]

// 2. the control-plane image's DSH_VERSION
const dockerfile = read('docker/dsh-web-platform.Dockerfile')
const dockerVersions = [...dockerfile.matchAll(/^ARG DSH_VERSION=(\S+)$/gm)].map((m) => m[1])
if (dockerVersions.length === 0) problems.push('docker/dsh-web-platform.Dockerfile declares no `ARG DSH_VERSION=`')
for (const version of dockerVersions) {
  if (version !== dependencyVersion) {
    problems.push(`docker/dsh-web-platform.Dockerfile ARG DSH_VERSION=${version} != dependency pin ${dependencyVersion}`)
  }
}

// 3. the release workflow's build-arg
const release = read('.github/workflows/release.yml')
const releaseVersions = [...release.matchAll(/^\s*DSH_VERSION=(\S+)\s*$/gm)].map((m) => m[1])
if (releaseVersions.length === 0) problems.push('.github/workflows/release.yml passes no DSH_VERSION build-arg')
for (const version of releaseVersions) {
  if (version !== dependencyVersion) {
    problems.push(`.github/workflows/release.yml DSH_VERSION=${version} != dependency pin ${dependencyVersion}`)
  }
}

// 4. the README compatibility matrix must name the same version
const readme = read('README.md')
if (dependencyVersion !== undefined && !readme.includes(dependencyVersion)) {
  problems.push(`README.md does not mention the pinned DSH version ${dependencyVersion} (compatibility matrix)`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`)
  console.error(`dsh-version check FAILED (${problems.length} problem(s))`)
  process.exit(1)
}
console.log(`ok   one DSH version everywhere: ${dependencyVersion}`)
