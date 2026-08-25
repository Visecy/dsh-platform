/**
 * @visecy/dsh-workspace-ui host half.
 *
 * The workspace UI lives in the browser half. This module only satisfies the
 * package shape; all workspace management/server APIs are provided by
 * @visecy/dsh-workspace-k8s.
 */
export const name = '@visecy/dsh-workspace-ui'

export interface Config {}

export function apply(): void {
  // No host-side behavior: workspace status/selection is a browser plugin.
}
