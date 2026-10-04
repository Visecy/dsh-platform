/**
 * The vendored fixture has to BE the official package the deployment loads.
 *
 * The rebind specs run against `tests/vendor/dsh-workspace/` precisely because
 * a hand-written fake once encoded the wrong `attachSession` ordering and let a
 * broken feature ship green. That fidelity is worth nothing if the fixture
 * quietly goes stale: a 0.1.5-rc.3 fixture sat under a 0.2.0-rc.2 platform and
 * the materializer kept resolving its 0.1.5-rc.2 peers out of a developer box's
 * cache, while release CI — whose store holds the shipped release only — failed
 * on a step that never mentioned a version.
 *
 * `pretest` already refuses to materialize a stale fixture, and this spec makes
 * the same invariant part of the suite: a bare `vitest run`, or a future
 * re-wiring of the npm scripts, still fails, naming both versions.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { checkFixtureRelease, RELEASE_ROOT_NAMES } from './vendor/fixture-release.mjs'

describe('vendored official fixture', () => {
  it('is the @deepseek-ai/dsh-workspace release this checkout installs', async () => {
    const release = await checkFixtureRelease()
    // Assert the message first: it names the version present and the version
    // expected, which is the whole point of the check.
    expect(release.problems.join('\n')).toBe('')
    expect(release.fixtureVersion).toBe(release.releaseVersion)
    expect(release.fixtureVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('is materialized from the peers that release declares', async () => {
    const release = await checkFixtureRelease()
    expect(release.ok).toBe(true)

    // The stamp is written by the materializer's transactional swap, so its
    // presence plus a matching fixture version means this is the tree built for
    // THESE bytes and not a leftover from an earlier fixture.
    const stamp = JSON.parse(
      await readFile(new URL('./vendor/node_modules/.materialized.json', import.meta.url), 'utf8'),
    )
    expect(stamp.fixture).toBe(release.fixtureVersion)
    expect(Object.keys(stamp.packages).length).toBeGreaterThan(0)

    // The peer roots are the release itself: if the store had moved on, the
    // fixture would be importing a different release than the one it claims.
    for (const name of RELEASE_ROOT_NAMES) {
      const manifest = JSON.parse(
        await readFile(new URL(`./vendor/node_modules/${name}/package.json`, import.meta.url), 'utf8'),
      )
      expect(`${name}@${manifest.version}`).toBe(`${name}@${release.fixtureVersion}`)
    }
  })
})
