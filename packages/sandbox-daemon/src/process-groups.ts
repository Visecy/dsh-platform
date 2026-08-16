/**
 * Process-group management for sandbox commands.
 * Each command runs under `setsid --wait` so the child owns a fresh session
 * (pgid === pid); termination signals the negative pgid (whole tree), with a
 * SIGTERM -> grace -> SIGKILL ladder. Status is published via files under a
 * per-command runtime directory so the daemon can observe liveness without
 * holding a Node child handle for the command's lifetime.
 */
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeFrame } from './framing.js'

export interface GroupStatus {
  pid: number
  pgid: number
  startedAt: number
}

export interface GroupExit {
  exitCode: number | null
  signal: string | null
  at: number
}

export interface ProcessGroup {
  cmdId: string
  dir: string
  pid: number
  pgid: number
  stdin: NodeJS.WritableStream
}

/**
 * Launch one command in its own session/group.
 * @returns the group (pid/pgid) once the child has published itself.
 */
export async function launchGroup(opts: {
  cmdId: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  runtimeRoot: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}): Promise<ProcessGroup> {
  const cmdId = opts.cmdId
  const dir = join(opts.runtimeRoot, 'processes', cmdId)
  await mkdir(dir, { recursive: true })

  // inner script: publish our pid (== pgid under setsid) then exec the real argv
  const inner = `printf '%s' \"\$\$\" > \"${dir}/pid\"; exec \"$@\"`
  const child = spawn('setsid', ['--wait', 'bash', '-c', inner, 'sh', ...opts.argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })
  // Output must be base64-framed before landing in the frame files.
  const frame = () =>
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        cb(null, encodeFrame(new Uint8Array(chunk)))
      },
    })
  child.stdout.pipe(frame()).pipe(opts.stdout)
  child.stderr.pipe(frame()).pipe(opts.stderr)

  // exit publication MUST be registered before the pid wait below: a fast
  // command can exit while we poll for the pid file, and a late listener
  // would miss the 'exit' event entirely. The status is only published once
  // stdout/stderr have fully drained, so readers never observe a truncated
  // frame file.
  child.once('exit', (code, signal) => {
    // Wait for the target write streams to flush (not just the child's read
    // side) so readers never observe a truncated frame file.
    void Promise.all([whenDrained(opts.stdout), whenDrained(opts.stderr)]).then(() =>
      writeFile(join(dir, 'exit.json'), JSON.stringify({ exitCode: code, signal, at: Date.now() })),
    )
  })

  // pid publication: setsid forks once, so $$ inside the script is the group leader.
  let pid = -1
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      pid = Number.parseInt(await readFile(join(dir, 'pid'), 'utf8'), 10)
      if (Number.isFinite(pid) && pid > 0) break
    } catch {
      // not published yet
    }
    await new Promise((res) => setTimeout(res, 10))
  }
  if (!(pid > 0)) {
    child.kill('SIGKILL')
    throw new Error('sandbox-daemon: failed to publish process group')
  }

  return { cmdId, dir, pid, pgid: pid, stdin: child.stdin }
}

export async function readGroupExit(dir: string): Promise<GroupExit | undefined> {
  try {
    const raw = await readFile(join(dir, 'exit.json'), 'utf8')
    return JSON.parse(raw) as GroupExit
  } catch {
    return undefined
  }
}

/**
 * Terminate a group: SIGTERM to -pgid, wait graceMs, SIGKILL if still alive.
 * Returns true when the group is quiescent afterwards.
 */
export async function terminateGroup(pgid: number, graceMs: number): Promise<boolean> {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    // ESRCH: already gone
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await new Promise((res) => setTimeout(res, 25))
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // already gone
  }
  // brief settle for the kernel to reap
  await new Promise((res) => setTimeout(res, 100))
  return !groupAlive(pgid)
}

function whenDrained(stream: NodeJS.WritableStream): Promise<void> {
  const w = stream as unknown as { writableFinished?: boolean; once?: (e: string, fn: () => void) => unknown }
  if (w.writableFinished === true) return Promise.resolve()
  return new Promise((res) => w.once?.('finish', res))
}

/** Probe whether any live process belongs to the group (zombies count as gone). */
export function groupAlive(pgid: number): boolean {
  try {
    const out = spawnSyncProbe(pgid)
    return out
  } catch {
    return false
  }
}

function spawnSyncProbe(pgid: number): boolean {
  // ps -eo pgid=,stat= | awk: any non-zombie row for the group
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  try {
    const out = execFileSync('ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const [g, stat] = line.trim().split(/\s+/)
      if (g === String(pgid) && stat !== undefined && !stat.startsWith('Z')) return true
    }
    return false
  } catch {
    return false
  }
}
