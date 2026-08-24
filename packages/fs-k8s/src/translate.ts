/**
 * Path translation between the host-side workspace identifier
 * (/workspaces/<workspaceId>) and the pod-side workspace root. The default
 * podRoot is '/workspaces', making host and pod views identical.
 * The host side never holds workspace content — cwd is a logical key.
 */
import { posix } from 'node:path'

export class PathTranslator {
  constructor(
    readonly hostRoot: string,
    readonly podRoot: string,
  ) {}

  /** Translate a host path to the pod-side path. Throws on escape. */
  toPod(hostPath: string): string {
    const normalized = posix.normalize(hostPath)
    if (normalized === this.hostRoot) return this.podRoot
    if (!normalized.startsWith(this.hostRoot + '/')) {
      throw new Error(`path escapes workspace root: ${hostPath}`)
    }
    return this.podRoot + normalized.slice(this.hostRoot.length)
  }

  /** Translate a pod path back to the host-side display path. */
  toHost(podPath: string): string {
    const normalized = posix.normalize(podPath)
    if (normalized === this.podRoot) return this.hostRoot
    if (!normalized.startsWith(this.podRoot + '/')) {
      throw new Error(`pod path escapes workspace root: ${podPath}`)
    }
    return this.hostRoot + normalized.slice(this.podRoot.length)
  }
}
