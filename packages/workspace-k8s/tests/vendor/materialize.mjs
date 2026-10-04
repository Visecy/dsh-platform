#!/usr/bin/env node
/**
 * Materialize the peer tree the vendored official-package fixture imports.
 *
 * `tests/vendor/dsh-workspace/` holds the exact bytes of the official
 * `@deepseek-ai/dsh-workspace` the deployed image loads — that is the entity
 * under test and it is committed on purpose. Its peers are NOT committed (they
 * are `node_modules/`, which `.gitignore` excludes), so a fresh checkout has to
 * reconstruct them. Doing that by hand from absolute pnpm-store paths cannot
 * work in CI; this script copies them out of THIS workspace's own pnpm virtual
 * store instead, so it needs no network and no machine-specific path: any
 * checkout that ran `pnpm install` can materialize the fixture.
 *
 * Wired as `pretest` in package.json, so `pnpm test` (and `pnpm -r test`) can
 * never run the rebind specs against a missing or stale peer tree.
 *
 * TWO things are checked, and both are the point:
 *
 * 1. The fixture still IS the release this checkout installs
 *    (`fixture-release.mjs`), before anything else happens. A store that
 *    happens to still cache the peers of an old fixture must not be able to
 *    make a stale fixture pass — that is precisely how a 0.1.5-rc.3 fixture
 *    survived on a developer box while release CI, whose store holds the
 *    current release only, failed.
 * 2. Every peer is present in the store. The REQUIRED SET comes from what the
 *    vendored bytes import at runtime; every RANGE is read from the shipped
 *    declaration that owns it (the fixture's own `package.json` for its peers
 *    and dependencies, the package's devDependency pins for the roots, and the
 *    resolved manifests in the store for what those pull in) — never from a
 *    literal that can outlive the bytes it described.
 *
 * The copy is transactional: every requirement is resolved and validated in the
 * store BEFORE anything is touched, a missing package aborts with the
 * `pnpm add -D` line that fixes it, and the tree is built next to the target
 * and swapped in, so a failure never leaves a half-populated fixture that fails
 * later with a confusing module-resolution error.
 *
 * `--force` rebuilds even when the current tree is already up to date.
 */
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkFixtureRelease,
  FIXTURE_MANIFEST,
  PACKAGE_DIR,
  PACKAGE_MANIFEST,
  readJson,
  VENDOR_DIR,
} from './fixture-release.mjs'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/workspace-k8s/tests/vendor
const TARGET_DIR = join(HERE, 'node_modules')
const STAMP_FILE = '.materialized.json'
const FORCE = process.argv.includes('--force')

const shown = (path) => relative(join(PACKAGE_DIR, '..', '..'), path) || path

/**
 * Every package the vendored bytes load at import time, in dependency order
 * (a `resolvedDependencyOf` source needs its owner resolved first), plus where
 * its version range is declared.
 *
 * The three devDependency roots are declared in `package.json`; the rest arrive
 * transitively through them and are listed here because the fixture needs their
 * flattened copies to be resolvable from this directory — the vendored
 * `dsh-workspace` imports only `@deepseek-ai/cordis`, `@deepseek-ai/dsh-brand`,
 * `@deepseek-ai/dsh-storage-domain` and `zod` at runtime, and its domain form
 * pulls in `@deepseek-ai/dsh-invariants` as an auto-installed peer, which pulls
 * `@deepseek-ai/schemastery`, which pulls `@deepseek-ai/cosmokit` and
 * `@standard-schema/spec`.
 *
 * Ranges are ranges on purpose: the store directory name carries a peer-hash
 * suffix that changes on every install, and the fixture must keep working when
 * the lockfile moves a peer to a newer patch of the same release train. What is
 * NOT a range is the decision of WHICH declaration a range comes from.
 */
const REQUIREMENTS = [
  {
    name: '@deepseek-ai/dsh-storage-domain',
    rangeFrom: { devDependency: '@deepseek-ai/dsh-storage-domain' },
    needed: "the registry's domain form (open/parse)",
  },
  {
    name: '@deepseek-ai/dsh-storage',
    rangeFrom: { devDependency: '@deepseek-ai/dsh-storage' },
    needed: 'UNIT_NAME_RE and the backend key helpers',
  },
  {
    name: '@deepseek-ai/dsh-brand',
    rangeFrom: { devDependency: '@deepseek-ai/dsh-brand' },
    needed: 'brandString/brandNumber in the entity and the domain spec',
  },
  {
    name: '@deepseek-ai/dsh-invariants',
    rangeFrom: { fixturePeer: '@deepseek-ai/dsh-invariants' },
    needed: 'auto-installed peer of the domain form',
  },
  {
    name: '@deepseek-ai/schemastery',
    rangeFrom: { resolvedDependencyOf: { package: '@deepseek-ai/dsh-storage-domain', name: '@deepseek-ai/schemastery' } },
    needed: 'the domain form plugin Config declaration',
  },
  {
    name: '@deepseek-ai/cosmokit',
    rangeFrom: { resolvedDependencyOf: { package: '@deepseek-ai/schemastery', name: '@deepseek-ai/cosmokit' } },
    needed: 'schemastery peer',
  },
  {
    name: '@standard-schema/spec',
    rangeFrom: { resolvedDependencyOf: { package: '@deepseek-ai/schemastery', name: '@standard-schema/spec' } },
    needed: 'schemastery peer',
  },
  {
    name: 'zod',
    rangeFrom: { fixtureDependency: 'zod' },
    needed: 'the record schemas parsed at the durability boundary',
    // Runtime files only: the fixture never touches zod's `src/`, the v3 or
    // mini entry points, or the type/CommonJS outputs, and dropping them keeps
    // the git-ignored tree small. Mirrors what the README documented.
    prune: ['src', 'v3', 'mini', 'v4-mini'],
    pruneFiles: /\.(?:d\.ts|d\.cts|cjs)$/,
  },
]

/** A requirement whose owning declaration does not name it at all. */
class DeclarationError extends Error {}

/**
 * Resolve one requirement's range from the shipped declaration that owns it.
 *
 * `fixturePeer` / `fixtureDependency` read the VENDORED manifest, so a
 * re-vendored fixture carries its own peer set with it; `resolvedDependencyOf`
 * reads the manifest of a package already resolved out of the store, so the
 * range is whatever the build that will actually be copied declares.
 */
function rangeOf(requirement, { packageManifest, fixtureManifest, resolvedByName }) {
  const source = requirement.rangeFrom
  if (source.devDependency !== undefined) {
    const range = packageManifest.devDependencies?.[source.devDependency]
    if (typeof range !== 'string' || range === '') {
      throw new DeclarationError(`not declared in ${shown(PACKAGE_MANIFEST)} devDependencies (fix: pnpm add -D ${source.devDependency}@<version>)`)
    }
    return { range, declaredIn: `${shown(PACKAGE_MANIFEST)} devDependencies['${source.devDependency}']` }
  }
  if (source.fixturePeer !== undefined) {
    const range = fixtureManifest.peerDependencies?.[source.fixturePeer]
    if (typeof range !== 'string' || range === '') {
      throw new DeclarationError(`the vendored fixture's ${shown(FIXTURE_MANIFEST)} does not declare peer '${source.fixturePeer}': the fixture's peer set changed, update REQUIREMENTS`)
    }
    return { range, declaredIn: `${shown(FIXTURE_MANIFEST)} peerDependencies['${source.fixturePeer}']` }
  }
  if (source.fixtureDependency !== undefined) {
    const range = fixtureManifest.dependencies?.[source.fixtureDependency]
    if (typeof range !== 'string' || range === '') {
      throw new DeclarationError(`the vendored fixture's ${shown(FIXTURE_MANIFEST)} does not declare dependency '${source.fixtureDependency}': the fixture's dependencies changed, update REQUIREMENTS`)
    }
    return { range, declaredIn: `${shown(FIXTURE_MANIFEST)} dependencies['${source.fixtureDependency}']` }
  }
  if (source.resolvedDependencyOf !== undefined) {
    const owner = resolvedByName.get(source.resolvedDependencyOf.package)
    if (owner === undefined) {
      throw new DeclarationError(`internal: '${source.resolvedDependencyOf.package}' must be resolved before '${requirement.name}' (REQUIREMENTS order)`)
    }
    const range = owner.manifest?.dependencies?.[source.resolvedDependencyOf.name]
    if (typeof range !== 'string' || range === '') {
      throw new DeclarationError(`resolved ${source.resolvedDependencyOf.package}@${owner.version} does not declare dependency '${source.resolvedDependencyOf.name}': the release changed what it pulls in, update REQUIREMENTS`)
    }
    return { range, declaredIn: `${source.resolvedDependencyOf.package}@${owner.version} dependencies['${source.resolvedDependencyOf.name}']` }
  }
  throw new DeclarationError(`internal: requirement carries no range source`)
}

// --- minimal semver (no dependency is available before the tree exists) -----

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text).trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0
    return a.length === 0 ? 1 : -1 // a release outranks a prerelease
  }
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** `^` and `~` upper bounds carry a `-0` prerelease, exactly like node-semver. */
function withPrereleaseZero(major, minor, patch) {
  return { major, minor, patch, prerelease: ['0'] }
}

function expandComparators(clause) {
  const comparators = []
  for (const token of clause.split(/\s+/).filter(Boolean)) {
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
    const op = match?.[1] ?? '='
    const version = parseVersion(match?.[2] ?? '')
    if (!version) throw new Error(`unsupported version range token '${token}'`)
    if (op === '^') {
      const upper = version.major > 0
        ? withPrereleaseZero(version.major + 1, 0, 0)
        : version.minor > 0
          ? withPrereleaseZero(0, version.minor + 1, 0)
          : withPrereleaseZero(0, 0, version.patch + 1)
      comparators.push({ op: '>=', version }, { op: '<', version: upper })
    } else if (op === '~') {
      comparators.push({ op: '>=', version }, { op: '<', version: withPrereleaseZero(version.major, version.minor + 1, 0) })
    } else {
      comparators.push({ op, version })
    }
  }
  return comparators
}

function testComparator(version, { op, version: bound }) {
  const order = compareVersions(version, bound)
  return op === '>=' ? order >= 0
    : op === '<=' ? order <= 0
      : op === '>' ? order > 0
        : op === '<' ? order < 0
          : order === 0
}

function satisfies(rawVersion, range) {
  const version = parseVersion(rawVersion)
  if (!version) return false
  return range.split('||').some((clause) => {
    const comparators = expandComparators(clause)
    if (!comparators.every((comparator) => testComparator(version, comparator))) return false
    // node-semver: a prerelease only matches a comparator set that carries a
    // prerelease for the SAME release tuple, so `^0.2.0-rc.2` accepts
    // 0.2.0-rc.3 but never 0.2.1-rc.1.
    if (version.prerelease.length === 0) return true
    return comparators.some((comparator) =>
      comparator.version.prerelease.length > 0
      && comparator.version.major === version.major
      && comparator.version.minor === version.minor
      && comparator.version.patch === version.patch)
  })
}

// --- pnpm virtual store ----------------------------------------------------

/**
 * `<workspace root>/node_modules/.pnpm` is pnpm's default virtual store; a
 * package-local `node_modules/.pnpm` exists when `virtual-store-dir` says so.
 * Both are candidates, nearest first, so this works from any checkout layout.
 */
function findVirtualStores(from) {
  const stores = []
  for (let dir = from; ;) {
    const candidate = join(dir, 'node_modules', '.pnpm')
    if (existsSync(candidate)) stores.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) return stores
    dir = parent
  }
}

function storeEntryVersion(entry, mangledName) {
  // `@scope+name@1.2.3` / `@scope+name@1.2.3_<peer-hash>` / `@scope+name@1.2.3(peer)(peer)`:
  // the version is followed only by pnpm's peer-hash suffix, if anything.
  const rest = entry.slice(mangledName.length + 1)
  return /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[_()].*)?$/.exec(rest)?.[1]
}

async function resolveRequirement(requirement, stores) {
  const mangled = requirement.name.replace('/', '+')
  const candidates = []
  const seen = []
  for (const store of stores) {
    for (const entry of await readdir(store)) {
      if (!entry.startsWith(`${mangled}@`)) continue
      const version = storeEntryVersion(entry, mangled)
      if (!version) continue
      seen.push(version)
      if (!satisfies(version, requirement.range)) continue
      const dir = join(store, entry, 'node_modules', ...requirement.name.split('/'))
      if (!existsSync(join(dir, 'package.json'))) continue
      candidates.push({ version, entry, dir, store })
    }
  }
  candidates.sort((a, b) =>
    compareVersions(parseVersion(b.version), parseVersion(a.version))
    || (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0))
  return { match: candidates[0], available: [...new Set(seen)].sort((a, b) => compareVersions(parseVersion(a), parseVersion(b))) }
}

function fixLine(requirement, available) {
  const newest = available.at(-1)
  return `pnpm add -D ${requirement.name}@${newest ?? requirement.range}`
}

// --- tree building ---------------------------------------------------------

async function pruneFilesIn(dir, requirement) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (requirement.prune?.includes(entry.name)) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      await pruneFilesIn(path, requirement)
    } else if (requirement.pruneFiles?.test(entry.name)) {
      await rm(path, { force: true })
    }
  }
}

/**
 * The package's own entry point, so a copy that lost a file is caught here.
 * `import` is preferred over `require`/`main`: the fixture is ESM, and zod's
 * `main` points at the CommonJS output this materializer prunes on purpose.
 */
async function entryPointOf(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const exported = manifest.exports?.['.']
  const entry = typeof exported === 'string'
    ? exported
    : exported?.import?.default ?? exported?.import ?? exported?.default ?? manifest.main
  return { manifest, entry: typeof entry === 'string' ? entry : undefined }
}

async function buildTree(buildDir, resolved) {
  await mkdir(buildDir, { recursive: true })
  for (const { requirement, match } of resolved) {
    const destination = join(buildDir, ...requirement.name.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await cp(match.dir, destination, { recursive: true, dereference: true })
    if (requirement.prune || requirement.pruneFiles) {
      await pruneFilesIn(destination, requirement)
    }
    const { manifest, entry } = await entryPointOf(destination)
    if (manifest.name !== requirement.name || manifest.version !== match.version) {
      throw new Error(`copied ${requirement.name} has manifest identity '${manifest.name}@${manifest.version}'`)
    }
    if (entry && !existsSync(join(destination, entry))) {
      throw new Error(`copied ${requirement.name}@${match.version} is missing its entry point '${entry}'`)
    }
  }
}

async function isUpToDate(resolved, fixtureVersion) {
  if (FORCE) return false
  const stampPath = join(TARGET_DIR, STAMP_FILE)
  if (!existsSync(stampPath)) return false
  let stamp
  try {
    stamp = JSON.parse(await readFile(stampPath, 'utf8'))
  } catch {
    return false
  }
  // A tree materialized for a different fixture is not this fixture's tree,
  // even when every peer version happens to match.
  if (stamp.fixture !== fixtureVersion) return false
  for (const { requirement, match } of resolved) {
    const recorded = stamp.packages?.[requirement.name]
    if (!recorded || recorded.entry !== match.entry || recorded.store !== match.store) return false
    if (recorded.version !== match.version) return false
    const manifestPath = join(TARGET_DIR, ...requirement.name.split('/'), 'package.json')
    if (!existsSync(manifestPath)) return false
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.version !== match.version) return false
    } catch {
      return false
    }
  }
  return true
}

// --- main ------------------------------------------------------------------

// The fixture must BE the release this checkout installs. Checked FIRST: a
// store that still caches the peers of an old fixture must not be able to make
// that fixture pass here, which is exactly how the 0.1.5-rc.3 fixture survived
// on a developer box whose store held both releases.
const release = await checkFixtureRelease()
if (!release.ok) {
  console.error('[vendor] the vendored fixture does not match the DSH release this checkout installs.')
  for (const problem of release.problems) console.error(`[vendor]   - ${problem}`)
  console.error('[vendor] the vendored fixture was left untouched; re-vendor it from the expected release and re-run `pnpm test`.')
  process.exit(1)
}

const packageManifest = await readJson(PACKAGE_MANIFEST)
const fixtureManifest = await readJson(FIXTURE_MANIFEST)

const stores = findVirtualStores(PACKAGE_DIR)
if (stores.length === 0) {
  console.error('[vendor] no pnpm virtual store found: this checkout has no installed dependencies.')
  console.error(`[vendor] looked for node_modules/.pnpm in ${PACKAGE_DIR} and every parent directory`)
  console.error('[vendor] fix: run `pnpm install` at the workspace root first (release CI does).')
  process.exit(1)
}

const failures = []
const resolved = []
const resolvedByName = new Map()
for (const requirement of REQUIREMENTS) {
  let range
  let declaredIn
  try {
    ({ range, declaredIn } = rangeOf(requirement, { packageManifest, fixtureManifest, resolvedByName }))
  } catch (error) {
    failures.push(`${requirement.name} (for ${requirement.needed})\n    range:    ${error.message}`)
    continue
  }
  const { match, available } = await resolveRequirement({ ...requirement, range }, stores)
  if (!match) {
    failures.push([
      `${requirement.name} (range ${range} from ${declaredIn}, for ${requirement.needed})`,
      `    store:    ${stores.join(', ')}`,
      `    found:    ${available.length > 0 ? available.join(', ') : 'no entry at all'}`,
      `    fix:      ${fixLine({ ...requirement, range }, available)}`,
    ].join('\n'))
    continue
  }
  match.manifest = JSON.parse(await readFile(join(match.dir, 'package.json'), 'utf8'))
  resolved.push({ requirement, match, range, declaredIn })
  resolvedByName.set(requirement.name, match)
}

if (failures.length > 0) {
  console.error('[vendor] cannot materialize the vendored fixture peer tree: required package(s) absent from the pnpm store.')
  for (const failure of failures) console.error(`[vendor]   - ${failure}`)
  console.error('[vendor] the vendored fixture was left untouched; fix the store and re-run `pnpm test`.')
  process.exit(1)
}

if (await isUpToDate(resolved, release.fixtureVersion)) {
  console.log(`[vendor] fixture peer tree up to date for @deepseek-ai/dsh-workspace@${release.fixtureVersion} (${resolved.length} packages, ${stores[0]})`)
  process.exit(0)
}

const buildDir = join(HERE, `.node_modules.build-${process.pid}`)
const backupDir = join(HERE, `.node_modules.old-${process.pid}`)
try {
  await rm(buildDir, { recursive: true, force: true })
  await buildTree(buildDir, resolved)
  await rm(backupDir, { recursive: true, force: true })
  if (existsSync(TARGET_DIR)) await rename(TARGET_DIR, backupDir)
  await rename(buildDir, TARGET_DIR)
  await rm(backupDir, { recursive: true, force: true })
} catch (error) {
  await rm(buildDir, { recursive: true, force: true })
  console.error(`[vendor] failed to materialize the fixture peer tree: ${error.message}`)
  console.error('[vendor] the previous tree (if any) was left in place; the specs must not run against a partial copy.')
  process.exit(1)
}

await writeFile(join(TARGET_DIR, STAMP_FILE), `${JSON.stringify({
  generatedBy: 'tests/vendor/materialize.mjs',
  fixture: release.fixtureVersion,
  stores,
  packages: Object.fromEntries(resolved.map(({ requirement, match }) => [requirement.name, {
    version: match.version,
    store: match.store,
    entry: match.entry,
  }])),
}, null, 2)}\n`)

const summary = resolved.map(({ requirement, match }) => `${requirement.name}@${match.version}`).join(', ')
console.log(`[vendor] materialized ${resolved.length} fixture peers for @deepseek-ai/dsh-workspace@${release.fixtureVersion} from ${stores[0]}`)
console.log(`[vendor]   ${summary}`)
console.log(`[vendor]   ranges declared in: ${[...new Set(resolved.map(({ declaredIn }) => declaredIn))].join('; ')}`)
