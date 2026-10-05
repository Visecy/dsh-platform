/**
 * The MESSAGE-TIME caller, transcribed from the installed official package.
 *
 * `@deepseek-ai/dsh-agent-instructions` (0.2.0-rc.2) identifies the project root
 * by walking UP from the session cwd to `/`, probing `<dir>/.git` at each step.
 * It runs on every turn, from `compose` (`lib/index.js:1124`) and from
 * `discoverInstructionFiles` (`lib/index.js:577`), both of which load the
 * baseline instruction set for the step. The transcription below is exact —
 * same walk, same predicate, same rethrow — because the acceptance criterion is
 * a real conversation and this is the smallest thing that can fail the same way:
 *
 *   lib/index.js:480  async function findProjectRoot(cwd, markers, fileSystem, signal) {
 *   lib/index.js:481    let current = resolve(cwd);
 *   lib/index.js:482    for (;;) {
 *   lib/index.js:483      for (const marker of markers) if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current;
 *   lib/index.js:484      const parent = dirname(current);
 *   lib/index.js:485      if (parent === current) return resolve(cwd);
 *   lib/index.js:486      current = parent;
 *   lib/index.js:487    }
 *   lib/index.js:488  }
 *   lib/index.js:451  async function existsAsMarker(path, fileSystem, signal) {
 *   lib/index.js:452    if (fileSystem !== void 0) try {
 *   lib/index.js:453      const target = await fileSystem.resolve(path, signalOptions(signal));
 *   lib/index.js:454      return await fileSystem.stat(target, signal) !== void 0;
 *   lib/index.js:455    } catch (error) {
 *   lib/index.js:456      signal?.throwIfAborted();
 *   lib/index.js:457      if (isMissingProviderPathError(error)) return false;
 *   lib/index.js:458      throw error;            // <-- the arm the turn dies in
 *   lib/index.js:459    }
 *   lib/index.js:410  function isMissingProviderPathError(error) {
 *   lib/index.js:411    return error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";
 *   lib/index.js:412  }
 *
 * The walk ALWAYS ends at `/` (`dirname('/') === '/'`), so the last probe of any
 * session with no `.git` anywhere in its ancestry is `/.git`. Kept in one place
 * so both the unit spec and the real-daemon integration spec exercise the same
 * caller instead of two paraphrases of it.
 */
import { posix } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** The official predicate, transcribed verbatim (`lib/index.js:410-412`). */
export function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'FS_NOT_FOUND'
}

/** `existsAsMarker` for a composition that HAS an fs provider (`lib/index.js:451-459`). */
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
 * official arm at `lib/index.js:458` rethrows.
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
