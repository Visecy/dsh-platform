/**
 * The one place that decides whether the committed fixture still IS the official
 * package the deployment loads.
 *
 * `tests/vendor/dsh-workspace/` holds the exact bytes of one
 * `@deepseek-ai/dsh-workspace` release, and that package is versioned in
 * lockstep with the DSH release this checkout installs. Nothing else in the
 * repository can tell those two apart: the vendored manifest is a copy of the
 * shipped one, so it agrees with itself no matter how old it is, and the
 * materializer's peer ranges were read FROM the fixture — which is exactly how
 * a 0.1.5-rc.3 fixture kept resolving 0.1.5-rc.2 peers on a developer box whose
 * pnpm store still cached them, while release CI (whose store holds 0.2 only)
 * failed on a step that has nothing to do with the fixture's version.
 *
 * So the expected version is read from OUTSIDE the fixture: the DSH packages
 * `packages/workspace-k8s/package.json` pins as devDependencies — the roots the
 * fixture's peers are materialized from, and therefore the release a frozen
 * `pnpm install` actually puts in this checkout's virtual store. Those pins must
 * be exact versions and must agree with each other; if a DSH release ever ships
 * its packages at different versions, that is a decision a human has to make
 * here, loudly, rather than something this script may guess.
 *
 * Imported by BOTH entry points so they cannot answer differently:
 * - `materialize.mjs` (the package's `pretest` hook), which runs before any spec
 *   in the package — including in release CI's `cd packages/workspace-k8s &&
 *   pnpm test`;
 * - `tests/vendor-fixture.spec.ts`, so a bare `vitest run` fails too.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `tests/vendor` — this module's own directory. */
export const VENDOR_DIR = dirname(fileURLToPath(import.meta.url))
/** `packages/workspace-k8s` — the package whose manifest pins the DSH release. */
export const PACKAGE_DIR = resolve(VENDOR_DIR, '..', '..')
/** The committed fixture: the exact bytes of the shipped `dsh-workspace`. */
export const FIXTURE_DIR = join(VENDOR_DIR, 'dsh-workspace')
export const FIXTURE_MANIFEST = join(FIXTURE_DIR, 'package.json')
export const PACKAGE_MANIFEST = join(PACKAGE_DIR, 'package.json')

/**
 * The devDependency roots that pin the installed DSH release. The fixture's
 * peers are materialized from these exact builds, so the release they agree on
 * is by construction the release the fixture has to be.
 */
export const RELEASE_ROOT_NAMES = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
]

/** An exact `x.y.z[-prerelease]` version — no `^`, `~`, `*` or `||`. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Read and parse a JSON manifest, with the failing path in the error. */
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const shown = (path) => relative(resolve(PACKAGE_DIR, '..', '..'), path) || path

/**
 * Compare the committed fixture against the DSH release this checkout pins.
 *
 * @returns `{ ok, fixtureVersion, releaseVersion, problems }` — `problems` are
 *   printable, already-prefixed lines; empty exactly when `ok` is true.
 */
export async function checkFixtureRelease({
  packageManifestPath = PACKAGE_MANIFEST,
  fixtureManifestPath = FIXTURE_MANIFEST,
} = {}) {
  const problems = []
  let fixtureManifest
  let packageManifest
  try {
    fixtureManifest = await readJson(fixtureManifestPath)
  } catch (error) {
    problems.push(`cannot read the vendored fixture manifest ${shown(fixtureManifestPath)}: ${error.message}`)
  }
  try {
    packageManifest = await readJson(packageManifestPath)
  } catch (error) {
    problems.push(`cannot read ${shown(packageManifestPath)}: ${error.message}`)
  }
  if (problems.length > 0) return { ok: false, problems }

  const fixtureVersion = fixtureManifest.version
  if (typeof fixtureVersion !== 'string' || !EXACT_VERSION_RE.test(fixtureVersion)) {
    problems.push(`the vendored fixture manifest carries no exact version: ${JSON.stringify(fixtureVersion)}`)
  }

  // Every root must be pinned exactly, and to the same release.
  const pinned = new Map()
  for (const name of RELEASE_ROOT_NAMES) {
    const spec = packageManifest.devDependencies?.[name]
    if (typeof spec !== 'string' || spec === '') {
      problems.push(`${shown(packageManifestPath)} devDependencies does not pin ${name} (fix: pnpm add -D ${name}@<release>)`)
    } else if (!EXACT_VERSION_RE.test(spec)) {
      problems.push(`${shown(packageManifestPath)} pins ${name} at '${spec}': it must be an exact DSH release version, not a range, or the fixture cannot be checked against it`)
    } else {
      pinned.set(name, spec)
    }
  }
  const releaseVersions = [...new Set(pinned.values())]
  if (releaseVersions.length > 1) {
    problems.push([
      `${shown(packageManifestPath)} pins the DSH release roots to different versions:`,
      ...[...pinned].map(([name, version]) => `    ${name}: ${version}`),
      '    they must name one release: the fixture is the exact bytes of that release\'s @deepseek-ai/dsh-workspace',
    ].join('\n'))
    return { ok: false, fixtureVersion, problems }
  }
  if (problems.length > 0) return { ok: false, fixtureVersion, problems }

  const releaseVersion = releaseVersions[0]
  if (fixtureVersion !== releaseVersion) {
    problems.push([
      `the vendored fixture is STALE: ${shown(FIXTURE_DIR)} holds @deepseek-ai/dsh-workspace@${fixtureVersion}, but this checkout installs DSH ${releaseVersion}.`,
      `    present  (${shown(fixtureManifestPath)}): ${fixtureVersion}`,
      `    expected (${shown(packageManifestPath)} devDependencies: ${RELEASE_ROOT_NAMES.join(', ')}): ${releaseVersion}`,
      `    the fixture is the exact bytes the deployed image loads, so it has to be re-vendored from the release the image installs:`,
      `    npm pack @deepseek-ai/dsh-workspace@${releaseVersion}   # see ${shown(join(VENDOR_DIR, 'README.md'))}, "Re-vendoring"`,
    ].join('\n'))
  }

  return { ok: problems.length === 0, fixtureVersion, releaseVersion, problems }
}
