/**
 * The MESSAGE-TIME caller, transcribed from the installed official package.
 *
 * `@deepseek-ai/dsh-agent-instructions` (0.2.1-rc.2) identifies the project root
 * by walking UP from the session cwd to `/`, probing `<dir>/.git` at each step.
 * It runs on every turn from the reconcile path (`lib/index.js:1025`,
 * `reconcileInstructionContext`) and from instruction-file discovery
 * (`lib/index.js:673`), plus baseline preparation (`lib/index.js:1244`). The
 * transcription below is exact — same walk, same predicate, same rethrow —
 * because the acceptance criterion is a real conversation and this is the
 * smallest thing that can fail the same way:
 *
 *   lib/index.js:574  async function findProjectRoot(cwd, markers, fileSystem, signal) {
 *   lib/index.js:575    let current = resolve(cwd);
 *   lib/index.js:576    for (;;) {
 *   lib/index.js:577      for (const marker of markers) if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current;
 *   lib/index.js:578      const parent = dirname(current);
 *   lib/index.js:579      if (parent === current) return resolve(cwd);
 *   lib/index.js:580      current = parent;
 *   lib/index.js:581    }
 *   lib/index.js:582  }
 *   lib/index.js:545  async function existsAsMarker(path, fileSystem, signal) {
 *   lib/index.js:546    if (fileSystem !== void 0) try {
 *   lib/index.js:547      const target = await fileSystem.resolve(path, signalOptions(signal));
 *   lib/index.js:548      return await fileSystem.stat(target, signal) !== void 0;
 *   lib/index.js:549    } catch (error) {
 *   lib/index.js:550      signal?.throwIfAborted();
 *   lib/index.js:551      if (isMissingProviderPathError(error)) return false;
 *   lib/index.js:552      throw error;            // <-- the arm the turn dies in
 *   lib/index.js:553    }
 *   lib/index.js:504  function isMissingProviderPathError(error) {
 *   lib/index.js:505    return error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";
 *   lib/index.js:506  }
 *
 * The walk ALWAYS ends at `/` (`dirname('/') === '/'`), so the last probe of any
 * session with no `.git` anywhere in its ancestry is `/.git`. Kept in one place
 * so both the unit spec and the real-daemon integration spec exercise the same
 * caller instead of two paraphrases of it.
 */
import { posix } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** The official predicate, transcribed verbatim (`lib/index.js:504-506`). */
export function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'FS_NOT_FOUND'
}

/** `existsAsMarker` for a composition that HAS an fs provider (`lib/index.js:545-553`). */
export async function existsAsMarker(fileSystem: FileSystem, path: string): Promise<boolean> {
  try {
    const target: FsTarget = await fileSystem.resolve(path)
    return await fileSystem.stat(target) !== undefined
  } catch (error) {
    if (isMissingProviderPathError(error)) return false
    throw error
  }
}

/**
 * The official walk. Returns the project root, or rethrows exactly what the
 * official arm at `lib/index.js:552` rethrows.
 *
 * @param markerPaths - every `<dir>/<marker>` probed, in order (evidence).
 */
export async function findProjectRoot(
  fileSystem: FileSystem,
  cwd: string,
  markers: readonly string[],
  markerPaths?: string[],
): Promise<string> {
  let current = posix.resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      const probe = posix.join(current, marker)
      markerPaths?.push(probe)
      if (await existsAsMarker(fileSystem, probe)) return current
    }
    const parent = posix.dirname(current)
    if (parent === current) return posix.resolve(cwd)
    current = parent
  }
}
