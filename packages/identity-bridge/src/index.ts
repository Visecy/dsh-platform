/**
 * @visecy/dsh-identity-bridge — the platform's identity seam over the official
 * Web composition. It replaces two compiled-artifact patches with official
 * extension points:
 *
 * 1. **Transport hook (P1).** The browser half of
 *    `@deepseek-ai/dsh-client-connection` reads `globalThis.__DSH_TRANSPORT__`
 *    and treats `transport.ownsHost === true` as "this page owns the Host",
 *    which is what makes `ctx.connection.isLoopback` true behind a reverse
 *    proxy (host-backed settings persistence, document store, produced-file
 *    affordances). A host plugin publishes that global by pushing a
 *    `{ kind: 'global', name, value }` row onto the table emitted by
 *    `webserver/index-inject` — the same mechanism upstream uses for
 *    `__DSH_CONNECTION_RECOVERY__`.
 *
 * 2. **Launch-token handoff (P2).** `ctx.connection.authenticatedUrl()` /
 *    `authorizeIndex()` are the official per-process exchange, and this plugin
 *    owns the exact `/` route that drives it, so the deployment never has to
 *    disable the official browser-session cookie layer.
 *
 * It also exposes the sidecar-vouched principal as `ctx.dshAuth`. The control
 * plane stays stateless: nothing here writes to disk, keeps per-user state, or
 * reads workspace paths.
 * @module @visecy/dsh-identity-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = '@visecy/dsh-identity-bridge'

/** The transport hook needs the webserver event seat to exist. */
export const inject = ['webServer']

/** Plugin config. */
export interface Config {
  /**
   * Absolute path of the `index.html` the root route serves. Defaults to the
   * dist index of the `@deepseek-ai/dsh-web-frontend` package installed for
   * this composition.
   */
  distIndex?: string
  /**
   * Public origin browsers use, `scheme://authority` with no trailing slash.
   * Defaults to the origin of the request being handed off.
   */
  publicOrigin?: string
}

/** The `globalThis` property the official browser client reads at boot. */
const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/**
 * Publish the browser transport hook.
 * @param ctx - plugin context carrying the webServer service.
 * @param _config - resolved plugin config.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } })
  })
}
