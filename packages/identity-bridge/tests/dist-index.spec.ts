/**
 * The root route must serve the same `index.html` the official frontend-static
 * fallback serves, and the official Web bundle resolves that file from the
 * `@deepseek-ai/dsh-web-frontend` package manifest rather than from config.
 * These tests pin the same rule, with fixtures instead of an installed image:
 * the first anchor that carries the frontend wins, and an anchor without it is
 * simply skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { frontendAnchors, resolveFrontendDistIndex } from '../src/index.ts'

const MANIFEST = '{"name":"@deepseek-ai/dsh-web-frontend","version":"0.0.0"}'

let root: string

beforeAll(async () => { root = await mkdtemp(join(process.cwd(), '.tmp-identity-bridge-')) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('resolveFrontendDistIndex', () => {
  it('resolves the frontend dist index from an anchor that carries the package', async () => {
    const frontend = join(root, 'image/node_modules/@deepseek-ai/dsh-web-frontend')
    await mkdir(join(frontend, 'dist'), { recursive: true })
    await writeFile(join(frontend, 'package.json'), MANIFEST)
    await writeFile(join(frontend, 'dist/index.html'), '<!doctype html><html></html>')

    expect(resolveFrontendDistIndex([join(root, 'image/lib/bin.js')])).toBe(join(frontend, 'dist/index.html'))
  })

  it('skips anchors without the frontend and reports no default', async () => {
    const empty = join(root, 'bare')
    await mkdir(empty, { recursive: true })
    expect(resolveFrontendDistIndex([join(empty, 'lib/bin.js')])).toBeUndefined()
  })

  it('offers this package and the running CLI as anchors', () => {
    const anchors = frontendAnchors()
    expect(anchors[0]).toContain('identity-bridge')
    expect(anchors.length).toBeGreaterThan(1)
  })
})
