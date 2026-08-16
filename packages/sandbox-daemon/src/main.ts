/**
 * CLI entry for the sandbox daemon (runs inside the workspace pod).
 * Env: DAEMON_ROOT (workspace dir, default /workspace),
 *      DAEMON_PORT (default 4390),
 *      DAEMON_COMMAND_TIMEOUT_MS (default 3h = 10_800_000, workspace-wide background grace).
 */
import { startDaemon } from './index.ts'

const root = process.env.DAEMON_ROOT ?? '/workspace'
const port = Number(process.env.DAEMON_PORT ?? '4390')
const commandTimeoutMs = Number(process.env.DAEMON_COMMAND_TIMEOUT_MS ?? (3 * 60 * 60 * 1000).toString())

const started = await startDaemon({ root, port, commandTimeoutMs })
console.log(`sandbox-daemon ready at ${started.baseUrl} (root=${root})`)
