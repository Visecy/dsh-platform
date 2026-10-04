/**
 * The platform's stdout sink for `ctx.logger`.
 *
 * Cordis's built-in exporter only ring-buffers in memory and `dsh-app-boot`'s
 * keeps warn/error for its StartupError path, so without this row every
 * platform warning and error is invisible in production (`kubectl logs` shows
 * nothing). These tests pin the observable contract the deployment depends on:
 *
 *  - a `warn`/`error` line from any plugin reaches STDOUT exactly once, with a
 *    timestamp, the level and the logger name;
 *  - the threshold is the row's `level` config, defaulting to `warn` (errors
 *    always pass, info/debug are opt-in);
 *  - nothing goes to stderr and nothing is written to a file (the control
 *    plane runs with `readOnlyRootFilesystem`);
 *  - the sink is installed once per root context and released with its fiber.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as loggingStdout from '../src/index.ts'

let undo: Array<() => void> = []
let stdout: string[] = []
let stderr: string[] = []

/** Intercept both process streams for one test. */
function intercept(): void {
  stdout = []
  stderr = []
  const sink = (chunks: string[]) =>
    ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as never
  undo = [
    vi.spyOn(process.stdout, 'write').mockImplementation(sink(stdout)),
    vi.spyOn(process.stderr, 'write').mockImplementation(sink(stderr)),
  ]
}

afterEach(() => {
  for (const restore of undo.splice(0)) restore()
})

async function mount(config?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(loggingStdout, config)
  return ctx
}

describe('@visecy/dsh-logging-stdout: the stdout sink for ctx.logger', () => {
  it('exports the loader shape, with a Config schema that defaults to warn', () => {
    expect(loggingStdout.name).toBe('@visecy/dsh-logging-stdout')
    expect(typeof loggingStdout.apply).toBe('function')
    const validated = loggingStdout.Config['~standard'].validate({})
    expect('value' in validated && validated.value).toEqual({ level: 'warn' })
  })

  it('writes one line per warn, and nothing to stderr', async () => {
    intercept()
    const ctx = await mount()
    ctx.logger('platform-subject').warn('reconcile pass failed: %s', 'timeout')
    expect(stderr).toEqual([])
    expect(stdout).toEqual([
      expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN {2}platform-subject: reconcile pass failed: timeout\n$/,
      ),
    ])
  })

  it('keeps normal operation quiet — info and debug are dropped, error is kept', async () => {
    intercept()
    const ctx = await mount()
    const log = ctx.logger('platform-subject')
    log.info('loaded 41 rows')
    log.debug('poll tick %o', { n: 2 })
    expect(stdout).toEqual([])
    log.error(new Error('workspace reconcile failed'))
    expect(stdout).toHaveLength(1)
    expect(stdout[0]).toContain('ERROR platform-subject:')
    expect(stdout[0]).toContain('workspace reconcile failed')
  })

  it('level: error drops warnings too', async () => {
    intercept()
    const ctx = await mount({ level: 'error' })
    const log = ctx.logger('platform-subject')
    log.warn('not an error')
    expect(stdout).toEqual([])
    log.error('real error')
    expect(stdout).toHaveLength(1)
    expect(stdout[0]).toContain('ERROR platform-subject: real error')
  })

  it('level: info adds info lines but still not debug', async () => {
    intercept()
    const ctx = await mount({ level: 'info' })
    const log = ctx.logger('platform-subject')
    log.debug('poll tick')
    expect(stdout).toEqual([])
    log.info('loaded 41 rows')
    log.warn('careful')
    log.error('broken')
    expect(stdout.map((line) => line.split(' ')[1])).toEqual(['INFO', 'WARN', 'ERROR'])
  })

  it('level: debug writes every level, in emission order', async () => {
    intercept()
    const ctx = await mount({ level: 'debug' })
    const log = ctx.logger('platform-subject')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(stdout.map((line) => line.split(' ')[1])).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  })

  it('writes a multi-line payload as exactly one record', async () => {
    intercept()
    const ctx = await mount()
    ctx.logger('platform-subject').error(new Error('boom'))
    expect(stdout).toHaveLength(1)
    expect(stdout[0].split('\n').length).toBeGreaterThan(2)
    expect(stdout[0].endsWith('\n')).toBe(true)
  })

  it('installs one sink per root context, even when the row is mounted twice', async () => {
    intercept()
    const ctx = new Context()
    await ctx.plugin(loggingStdout, {})
    await ctx.plugin(loggingStdout, {})
    ctx.logger('platform-subject').warn('once')
    expect(stdout).toEqual([expect.stringContaining('WARN  platform-subject: once')])
  })

  it('releases the sink with its fiber, but only once the last holder is gone', async () => {
    intercept()
    const ctx = new Context()
    const first = await ctx.plugin(loggingStdout, {})
    const second = await ctx.plugin(loggingStdout, {})
    const log = ctx.logger('platform-subject')
    log.warn('one')
    await first.dispose()
    log.warn('two')
    expect(stdout).toHaveLength(2)
    await second.dispose()
    log.warn('three')
    expect(stdout).toHaveLength(2)
  })

  it('depends on no other platform package and never touches the filesystem', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const runtime = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
    expect(runtime.filter((dependency) => dependency.startsWith('@visecy/'))).toEqual([])
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]node:fs/)
    expect(source).not.toMatch(/from ['"]@visecy\//)
  })
})
