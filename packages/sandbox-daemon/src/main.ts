/**
 * CLI entry for the sandbox daemon (runs inside the workspace pod).
 * Env: DAEMON_ROOT (workspace dir, default /workspace),
 *      DAEMON_PORT (default 4390),
 *      DAEMON_RUNTIME_ROOT (optional; absolute directory for the daemon's own
 *        runtime state — command/pty frame files, process pid and exit records.
 *        Default: the pod's own ephemeral area, see src/runtime.ts. Refused at
 *        boot when it is relative or inside DAEMON_ROOT, because that state must
 *        never land in the user's workspace),
 *      DAEMON_COMMAND_TIMEOUT_MS (default 3h = 10_800_000, workspace-wide background grace).
 */
import { startDaemon } from './index.ts'

const root = process.env.DAEMON_ROOT ?? '/workspace'
const port = Number(process.env.DAEMON_PORT ?? '4390')
const runtimeRoot = process.env.DAEMON_RUNTIME_ROOT
const commandTimeoutMs = Number(process.env.DAEMON_COMMAND_TIMEOUT_MS ?? (3 * 60 * 60 * 1000).toString())

const started = await startDaemon({ root, port, commandTimeoutMs, runtimeRoot })
console.log(`sandbox-daemon ready at ${started.baseUrl} (root=${root}, runtimeRoot=${started.runtimeRoot})`)
