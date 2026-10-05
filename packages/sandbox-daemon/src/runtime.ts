/**
 * Where the daemon keeps its OWN runtime state — the frame files of running
 * commands and terminals, and the pid/exit records of their process groups.
 *
 * This is NOT the workspace. `DaemonOptions.root` is the user's workspace: the
 * PVC mount, mounted and served as the file API's root, whose contents the
 * operator browses, commits and hands to an agent. Everything below is per-POD
 * state instead: it is produced and read back by this process alone, a command
 * cannot outlive its pod, and none of it is user content. Keeping the two in
 * one directory put `commands/`, `processes/` and `ptys/` inside every
 * workspace the operator created — visible in the file browser, in
 * `git status`, and to the agent.
 *
 * The default location is the pod's own ephemeral area, keyed by the workspace
 * root so two daemons on one host (tests, local development) never share a
 * state directory:
 *
 *   <tmpdir>/dsh-sandbox-daemon/<12 hex of sha256(workspace root)>
 *
 * In a workspace pod that is the container's writable layer: it lives exactly
 * as long as the state does (both die with the pod), it needs no volume mount,
 * so the safe default works in any deployment without a chart change, and it
 * is outside every path the file API can address.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize, relative } from 'node:path'

/** The pod-local directory a daemon uses when none is configured. */
export function defaultRuntimeRoot(workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
  return join(tmpdir(), 'dsh-sandbox-daemon', key)
}

/**
 * `candidate` is `parent` itself or lies underneath it.
 *
 * Lexical on purpose: it is a misconfiguration guard for the operator's own
 * environment, not a sandbox boundary (the file API's confinement is that, and
 * it lives in `FilesService`).
 */
function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true
  const rel = relative(parent, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Validate, create, and return the daemon's runtime root.
 *
 * Three refusals, each of which used to be a silent way to put per-pod state
 * back into the user's tree or into an unpredicted directory:
 *
 *   - a RELATIVE root, which would be resolved against the daemon's own cwd
 *     (the invariant `resolve(opts.root)` protects for the workspace root:
 *     child shells run with their own cwd, so a relative runtime path is
 *     resolved by whichever process happens to write it);
 *   - a root that IS or lies INSIDE the workspace root — the exact bug this
 *     module exists to prevent;
 *   - a root that cannot be created, reported at boot instead of turning every
 *     later command into an I/O error.
 *
 * @param workspaceRoot - the resolved, absolute workspace root (the file
 *   service's root and the PVC mount).
 * @param configured - `DAEMON_RUNTIME_ROOT`, or undefined for the default.
 * @returns the absolute runtime root, created on disk.
 */
export async function prepareRuntimeRoot(workspaceRoot: string, configured?: string): Promise<string> {
  const chosen = configured === undefined ? defaultRuntimeRoot(workspaceRoot) : configured
  if (!isAbsolute(chosen)) {
    throw new Error(
      `sandbox-daemon: runtimeRoot must be absolute (got ${JSON.stringify(chosen)}): `
      + 'a relative path is resolved by whichever process writes into it, which is how runtime state '
      + 'ended up inside the user\'s workspace; set DAEMON_RUNTIME_ROOT to an absolute path outside it',
    )
  }
  const root = normalize(chosen)
  if (isInside(workspaceRoot, root)) {
    throw new Error(
      `sandbox-daemon: runtimeRoot must be outside the workspace root ${workspaceRoot} — that directory is the `
      + `user's workspace (their PVC, shown in the file browser and in git status), while runtime state is `
      + `per-pod; refusing ${root}. Use an absolute path outside the workspace, or unset DAEMON_RUNTIME_ROOT for `
      + `the default (${defaultRuntimeRoot(workspaceRoot)})`,
    )
  }
  try {
    await mkdir(root, { recursive: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`sandbox-daemon: runtimeRoot ${root} is not usable (${detail})`)
  }
  return root
}
