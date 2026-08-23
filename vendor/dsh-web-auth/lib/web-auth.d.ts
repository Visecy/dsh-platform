/**
 * @deepseek-ai/dsh-host-web-auth — password gate for the Web shell. Mounts
 * idle and claims the webserver request-gate seat plus a `/login` exact route
 * only when a `password` is configured: every request — named routes, the SPA
 * fallback, and WebSocket upgrades — must then carry a session cookie minted
 * by a successful login. The cookie is an expiry-stamped HMAC-SHA256
 * capability over the configured secret (a random per-boot secret when none
 * is set), so no server-side session store exists and restarts invalidate
 * sessions. The gate is the deployment's authentication layer in front of the
 * GUI; the connection plugin's loopback-pinned privileged RPC methods remain
 * pinned regardless.
 * @module dsh-web-auth/web-auth
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "web-auth";
/** Plugin config: the gate's password, cookie-signing secret, and session lifetime. */
export interface Config {
    /**
     * Password protecting the browser surface; absent or empty leaves the
     * plugin idle — no gate, no login route. Deployments should pass it through
     * an environment variable rather than a config file that may be committed.
     */
    password?: string;
    /**
     * HMAC key signing session cookies; absent derives a random per-boot secret,
     * which invalidates every session on restart (users simply log in again).
     */
    secret?: string;
    /** Session cookie lifetime in seconds after login. */
    sessionTtlSeconds: number;
}
export declare const Config: z<Config>;
/** Test hook: session-token and comparison primitives with an injectable clock. */
export declare const internals: {
    signToken: (secret: string, ttlMs: number) => string;
    validToken: (secret: string, token: string | undefined, nowMs: number) => boolean;
    safeEqual: (a: string, b: string) => boolean;
};
/**
 * Mount the gate: claims the webserver request-gate seat and the `/login`
 * route only when a password is configured and a webServer service exists;
 * an idle mount registers nothing and does not depend on the webserver row.
 * The webServer dependency is injected conditionally so a composition that
 * disables the transport (an agent-preset test without the GUI carrier) still
 * boots the idle row; when armed, the gate whitelists `/login`, admits
 * requests carrying a valid session cookie, answers `/api` and upgrade
 * requests with 401 (never a redirect, so JSON clients and WebSocket
 * handshakes are not confused), and redirects other GET/HEAD browser
 * navigations to the login page.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=web-auth.d.ts.map