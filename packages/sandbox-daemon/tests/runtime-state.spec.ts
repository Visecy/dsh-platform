/**
 * The daemon's OWN runtime state lives in the pod's ephemeral area — never in
 * the user's workspace.
 *
 * `startDaemon` used to hand ONE root to two different consumers: the file
 * service (correct — that root IS the user's workspace, the PVC mount) and the
 * command/pty registries (wrong — their frame files, pid files and exit records
 * are per-POD state). So every command run in a workspace created
 * `<workspace>/commands/<id>/…` and `<workspace>/processes/<id>/…`, and every
 * terminal created `<workspace>/ptys/<id>/…`: visible in the file browser, in
 * `git status`, and to the agent itself.
 *
 * The operator's acceptance criterion is stronger than "the dirs are ignored":
 * a command run through the daemon must leave the workspace tree BYTE-IDENTICAL
 * except for what the command itself creates. These specs pin that with a
 * content-hash snapshot of the whole tree, against the real HTTP daemon, and
 * pin the location the state moved to, the default that applies when nothing is
 * configured, and the refusals that keep a misconfiguration from silently
 * putting the state back inside the workspace.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { startDaemon, type DaemonOptions, type StartedDaemon } from '../src/index.ts'

/** relative path -> `dir` | `file:<sha256>` | `other` (never follows symlinks). */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.set(rel, 'dir')
        await walk(abs, rel)
      } else if (entry.isFile()) {
        out.set(rel, `file:${createHash('sha256').update(await readFile(abs)).digest('hex')}`)
      } else {
        // A kind this walk does not hash (symlink, socket, …): recorded as a
        // kind so a command creating one still shows up as a difference.
        out.set(rel, 'other')
      }
    }
  }
  await walk(root, '')
  return out
}

/** Every key `after` has that `before` did not — the command's own creations. */
function added(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((key) => !before.has(key)).sort()
}

/** Every key whose kind or content moved. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...before.keys()].filter((key) => after.get(key) !== before.get(key)).sort()
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false)

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8')

let workspace: string
let state: string
let started: StartedDaemon

const post = async (path: string, body: unknown): Promise<{ ok: boolean; data: any }> => {
  const res = await fetch(started.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ ok: boolean; data: any }>
}

const get = async (path: string): Promise<{ ok: boolean; data: any }> => {
  const res = await fetch(started.baseUrl + path)
  return res.json() as Promise<{ ok: boolean; data: any }>
}

/**
 * Run one command through the HTTP API and wait for its managed range to end.
 * `cwd` is a REAL process path in the pod (the command's own working
 * directory), which is why the workspace's own path is passed in — the file
 * API's root-relative paths are a different path space.
 */
const run = async (script: string, cwd = '/'): Promise<string> => {
  const info = await post('/commands/run', { spec: { argv: ['sh', '-c', script], cwd } })
  expect(info.ok).toBe(true)
  const cmdId = info.data.cmdId as string
  const deadline = Date.now() + 8000
  for (;;) {
    const st = (await get(`/commands/${cmdId}/status`)).data.status
    if (st.phase === 'exited' || st.phase === 'killed') return cmdId
    if (Date.now() > deadline) throw new Error(`command did not exit: ${JSON.stringify(st)}`)
    await new Promise((res) => setTimeout(res, 25))
  }
}

beforeEach(async () => {
  // The PVC mount, with pre-existing user content in it.
  workspace = await mkdtemp(join(process.cwd(), '.tmp-runtime-ws-'))
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'keep.txt'), 'user bytes\n')
  await writeFile(join(workspace, 'sub', 'nested.txt'), 'nested bytes\n')
  // The pod's own ephemeral area, standing in for /tmp inside the container.
  state = await mkdtemp(join(process.cwd(), '.tmp-runtime-state-'))
  started = await startDaemon({ root: workspace, runtimeRoot: state, port: 0, commandTimeoutMs: 30_000 })
})

afterEach(async () => {
  await new Promise<void>((res) => started.server.close(() => res()))
  await rm(workspace, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

describe('a command through the daemon leaves the workspace byte-identical', () => {
  it('adds nothing at all for a command that creates nothing', async () => {
    const before = await snapshot(workspace)

    const cmdId = await run('true')

    const after = await snapshot(workspace)
    expect(added(before, after)).toEqual([])
    expect(changed(before, after)).toEqual([])
    // The state exists — just not in the workspace: the per-command frame files
    // and the per-process pid/exit records are under the pod's own root.
    expect(await exists(join(state, 'commands', cmdId, 'stdout.frames'))).toBe(true)
    expect(await exists(join(state, 'commands', cmdId, 'stderr.frames'))).toBe(true)
    expect(await exists(join(state, 'processes', cmdId, 'pid'))).toBe(true)
    expect(await exists(join(state, 'processes', cmdId, 'exit.json'))).toBe(true)
    // The old shape: `<workspace>/commands` and `<workspace>/processes`.
    expect(await exists(join(workspace, 'commands'))).toBe(false)
    expect(await exists(join(workspace, 'processes'))).toBe(false)
  })

  it("shows exactly the file the command itself created, and nothing else", async () => {
    const before = await snapshot(workspace)

    await run('echo made-by-the-command > made.txt && mkdir made-dir', workspace)

    const after = await snapshot(workspace)
    expect(added(before, after)).toEqual(['made-dir', 'made.txt'])
    expect(changed(before, after)).toEqual([])
    expect(await readFile(join(workspace, 'made.txt'), 'utf8')).toBe('made-by-the-command\n')
  })

  it('reads its own output back through the API while the frames stay out of the tree', async () => {
    const before = await snapshot(workspace)

    const cmdId = await run('echo frames-live-outside-the-workspace')
    const out = await get(`/commands/${cmdId}/output?stream=stdout&from=0`)
    const decoded = out.data.frames.trim().split('\n').filter(Boolean)
      .map((line: string) => unb64(line)).join('')

    expect(decoded).toBe('frames-live-outside-the-workspace\n')
    expect(added(before, await snapshot(workspace))).toEqual([])
  })

  it('keeps a terminal session out of the workspace too', async () => {
    const before = await snapshot(workspace)

    const created = await post('/ptys', {
      spec: { argv: ['bash', '--noprofile', '--norc', '-i'], cwd: workspace, rows: 24, cols: 80 },
    })
    expect(created.ok).toBe(true)
    const ptyId = created.data.ptyId as string
    await post(`/ptys/${ptyId}/write`, { data: b64('printf pty-outside\n') })
    await new Promise((res) => setTimeout(res, 500))
    const out = await get(`/ptys/${ptyId}/output?from=0`)
    expect(unb64(out.data.frames.trim().split('\n').filter(Boolean).join(''))).toContain('pty-outside')
    await post(`/ptys/${ptyId}/terminate`, { graceMs: 300 })

    expect(added(before, await snapshot(workspace))).toEqual([])
    expect(await exists(join(workspace, 'ptys'))).toBe(false)
    expect(await exists(join(state, 'ptys', ptyId, 'output.frames'))).toBe(true)
  })

  it('still serves the workspace itself, and still refuses to escape it', async () => {
    // The file half keeps its root: reads/writes address the PVC mount …
    const written = await post('/files/write', { path: '/written.txt', content: b64('through the api') })
    expect(written.ok).toBe(true)
    expect(await readFile(join(workspace, 'written.txt'), 'utf8')).toBe('through the api')
    // … while the files API can never reach the runtime area (a different,
    // non-confined root), and OUT_OF_ROOT stays the permission answer.
    const outside = await post('/files/read', { path: '../../etc/passwd' })
    expect(outside.ok).toBe(false)
    expect(outside.data.error.code).toBe('OUT_OF_ROOT')
  })
})

describe('the runtime area when nothing is configured', () => {
  let defaultWorkspace: string
  let defaultStarted: StartedDaemon

  beforeEach(async () => {
    defaultWorkspace = await mkdtemp(join(process.cwd(), '.tmp-runtime-default-'))
    await writeFile(join(defaultWorkspace, 'keep.txt'), 'user bytes\n')
    defaultStarted = await startDaemon({ root: defaultWorkspace, port: 0, commandTimeoutMs: 30_000 })
  })

  afterEach(async () => {
    await new Promise<void>((res) => defaultStarted.server.close(() => res()))
    await rm(defaultWorkspace, { recursive: true, force: true })
    await rm(defaultStarted.runtimeRoot, { recursive: true, force: true })
  })

  it('defaults to the pod\'s own ephemeral area, outside the workspace', async () => {
    expect(isAbsolute(defaultStarted.runtimeRoot)).toBe(true)
    expect(defaultStarted.runtimeRoot.startsWith(tmpdir())).toBe(true)
    const inside = defaultStarted.runtimeRoot === defaultWorkspace
      || defaultStarted.runtimeRoot.startsWith(defaultWorkspace + '/')
    expect(inside).toBe(false)

    const before = await snapshot(defaultWorkspace)
    const info = await fetch(`${defaultStarted.baseUrl}/commands/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { argv: ['sh', '-c', 'true'], cwd: '/' } }),
    }).then((res) => res.json() as Promise<{ ok: boolean; data: { cmdId: string } }>)
    expect(info.ok).toBe(true)
    expect(await exists(join(defaultStarted.runtimeRoot, 'commands', info.data.cmdId, 'stdout.frames'))).toBe(true)
    expect(added(before, await snapshot(defaultWorkspace))).toEqual([])
  })
})

describe('a runtime root that would put state back in the user\'s tree is refused', () => {
  let probeRoot: string

  beforeEach(async () => {
    probeRoot = await mkdtemp(join(process.cwd(), '.tmp-runtime-refuse-'))
  })

  afterEach(async () => {
    await rm(probeRoot, { recursive: true, force: true })
  })

  /** The refusal `startDaemon` must produce for `opts`; closes a leaked daemon. */
  const refusal = async (opts: DaemonOptions): Promise<Error> => {
    const result: StartedDaemon | Error = await startDaemon(opts).then(
      (daemon: StartedDaemon) => daemon,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )
    if (!(result instanceof Error)) {
      await new Promise<void>((res) => result.server.close(() => res()))
      throw new Error(`startDaemon accepted a runtime root it must refuse: ${JSON.stringify(opts.runtimeRoot)}`)
    }
    return result
  }

  it('refuses a runtime root equal to the workspace root', async () => {
    const failure = await refusal({ root: probeRoot, runtimeRoot: probeRoot, port: 0, commandTimeoutMs: 1000 })
    expect(failure.message).toContain('runtimeRoot')
    expect(failure.message).toContain(probeRoot)
  })

  it('refuses a runtime root inside the workspace root', async () => {
    const failure = await refusal({
      root: probeRoot,
      runtimeRoot: join(probeRoot, 'commands'),
      port: 0,
      commandTimeoutMs: 1000,
    })
    expect(failure.message).toMatch(/outside the workspace root/)
  })

  it('refuses a relative runtime root instead of resolving it against the daemon cwd', async () => {
    const failure = await refusal({ root: probeRoot, runtimeRoot: 'state', port: 0, commandTimeoutMs: 1000 })
    expect(failure.message).toMatch(/must be absolute/)
  })

  it('refuses to start when the runtime area cannot be created', async () => {
    // A regular file where a directory would have to be: mkdir fails ENOTDIR
    // for every user, root included.
    const blocker = join(probeRoot, 'blocker')
    await writeFile(blocker, 'not a directory')
    const failure = await refusal({
      root: probeRoot,
      runtimeRoot: join(blocker, 'state'),
      port: 0,
      commandTimeoutMs: 1000,
    })
    expect(failure.message).toContain('runtimeRoot')
  })
})
