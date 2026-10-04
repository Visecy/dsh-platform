#!/usr/bin/env node
/**
 * Assert that the OFFICIAL CLI refuses a non-loopback bind.
 *
 * Why this exists: with the in-process gate deleted, the identity headers are
 * only trustworthy because of the topology — the process must be reachable
 * solely through the authenticating proxy. Half of that precondition is not our
 * configuration at all: DSH itself refuses `--host 0.0.0.0`
 * (`@deepseek-ai/dsh-web-app/startup` errors out before anything listens).
 * This script turns that upstream behaviour into an in-repo assertion, so a DSH
 * upgrade that loses the guard fails the harness loudly instead of silently
 * opening an impersonation path (README: 部署硬前提 #2).
 *
 * Usage: node scripts/check-loopback-bind.mjs <dsh-home>
 *   <dsh-home> is the DSH_HOME the harness profile was built into; the check
 *   boots that profile's CLI path far enough for the web app to parse its flags.
 *
 * Exits non-zero when the CLI does not refuse the non-loopback bind.
 */
import { spawnSync } from 'node:child_process'

const home = process.argv[2]
if (home === undefined || home === '') {
  console.error('usage: check-loopback-bind.mjs <dsh-home>')
  process.exit(2)
}

/** The official refusal, as emitted by @deepseek-ai/dsh-web-app/startup. */
const REFUSAL = /--host 0\.0\.0\.0[^\n]*not supported/i

const result = spawnSync('dsh', ['--profile', 'web', '--host', '0.0.0.0'], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
  timeout: 120_000,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

if (result.error?.code === 'ENOENT') {
  console.error('loopback-bind check FAILED: no `dsh` on PATH (precondition #2 cannot be asserted)')
  process.exit(1)
}
if (result.error?.code === 'ETIMEDOUT') {
  console.error('loopback-bind check FAILED: `dsh --host 0.0.0.0` hung instead of refusing the bind (precondition #2: the CLI must reject a non-loopback bind)')
  process.exit(1)
}
if (!REFUSAL.test(output)) {
  console.error('loopback-bind check FAILED — precondition #2 (只能经认证代理到达 / loopback 绑定) is NOT enforced by DSH:')
  console.error(`  \`dsh --profile web --host 0.0.0.0\` exited ${String(result.status)} without the official refusal.`)
  console.error(`  observed output: ${output.trim().split('\n').slice(0, 3).join(' | ') || '(empty)'}`)
  console.error('  If DSH now accepts a non-loopback bind, the deployment must enforce the loopback bind itself;')
  console.error('  a direct caller could otherwise assert X-Forwarded-User and impersonate any user.')
  process.exit(1)
}

console.log(`ok   official CLI refuses --host 0.0.0.0 (exit ${String(result.status)}): ${output.trim().split('\n')[0]}`)
