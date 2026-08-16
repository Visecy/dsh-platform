/**
 * Environment hygiene for sandbox child processes.
 * Mirrors dsh's scrubbedParentEnv: ambient sensitive variables
 * (KEY|PASSWORD|SECRET|TOKEN patterns and DSH_* names) never reach a child
 * implicitly; only explicitly allowed entries (from CommandSpec.env) are
 * injected.
 */
const SENSITIVE = /(KEY|PASSWORD|SECRET|TOKEN)/i
const DSH_PREFIX = /^DSH_/

/**
 * Build the final environment for a child process.
 * - base: ambient env (from process.env) with sensitive + DSH_* names removed
 * - spec.env: merged after scrubbing, explicit values win (undefined deletes)
 */
export function scrubEnv(ambient: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(ambient)) {
    if (v === undefined) continue
    if (SENSITIVE.test(k) || DSH_PREFIX.test(k)) continue
    out[k] = v
  }
  return out
}

/** Merge explicit spec env over the scrubbed base (undefined = tombstone). */
export function mergeEnv(
  base: Record<string, string>,
  specEnv: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out = { ...base }
  for (const [k, v] of Object.entries(specEnv ?? {})) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}
