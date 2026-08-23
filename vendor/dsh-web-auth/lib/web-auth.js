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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export const name = 'web-auth';
export const Config = z.object({
    password: z.string(),
    secret: z.string().min(1),
    sessionTtlSeconds: z.natural().min(60).default(7 * 24 * 3600),
});
/** Cookie name carrying the session capability. */
const COOKIE_NAME = 'dsh_session';
/** Login page path, whitelisted by the gate so the route can serve itself. */
const LOGIN_PATH = '/login';
/** The /api prefix the browser transport owns; API calls get 401, never a redirect. */
const API_PATH = '/api';
/** Maximum login form body accepted; a larger POST is refused as a login failure. */
const LOGIN_BODY_LIMIT_BYTES = 8192;
/** Session token: `${expiryMs}.${base64url(hmacSha256(secret, expiryMs))}`. */
function signToken(secret, ttlMs) {
    const expiry = String(Date.now() + ttlMs);
    return `${expiry}.${createHmac('sha256', secret).update(expiry).digest('base64url')}`;
}
/**
 * Whether a session token is a valid unexpired capability for the secret.
 * Both signature arms compare in constant time after a length guard, so a
 * malformed cookie neither throws nor leaks the secret through timing.
 * @param secret - the signing key.
 * @param token - the cookie value, when present.
 * @param nowMs - the clock reading the decision compares expiry against.
 * @returns true when the signature verifies and the expiry is in the future.
 */
function validToken(secret, token, nowMs) {
    if (token === undefined)
        return false;
    const dot = token.lastIndexOf('.');
    if (dot === -1)
        return false;
    const expiry = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = createHmac('sha256', secret).update(expiry).digest('base64url');
    if (signature.length !== expected.length)
        return false;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        return false;
    const expiryMs = Number(expiry);
    return Number.isFinite(expiryMs) && expiryMs > nowMs;
}
/** Constant-time string comparison: both sides hash to a fixed length first. */
function safeEqual(a, b) {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}
/** The session cookie value from a Cookie header, when present. */
function sessionCookie(cookieHeader) {
    if (cookieHeader === undefined)
        return undefined;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1)
            continue;
        if (part.slice(0, eq).trim() !== COOKIE_NAME)
            continue;
        const value = part.slice(eq + 1).trim();
        return value === '' ? undefined : value;
    }
    return undefined;
}
/** The login page body: a self-contained form so the gate whitelists one path. */
function loginPage(showError) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness · 访问验证</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f6f8; color: #1f2329; }
  .card { width: min(360px, 92vw); padding: 32px 28px; background: #fff; border-radius: 12px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.08); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { margin: 0 0 20px; color: #646a73; }
  label { display: block; margin-bottom: 6px; font-weight: 600; }
  input { width: 100%; padding: 9px 12px; margin-bottom: 14px; border: 1px solid #d0d3d9;
    border-radius: 8px; font-size: 14px; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #2563eb;
    color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { margin: 0 0 14px; padding: 8px 10px; border-radius: 8px; background: #fdecea;
    color: #c0392b; }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e8eaed; }
    .card { background: #1e2126; box-shadow: none; }
    .sub { color: #9aa0a8; }
    input { background: #14161a; border-color: #3a3f46; color: #e8eaed; }
    .error { background: #3a1d1d; color: #f2a6a0; }
  }
</style>
</head>
<body>
<main class="card">
  <h1>DeepSeek Harness</h1>
  <p class="sub">此界面受密码保护，请输入访问密码。</p>
  ${showError ? '<p class="error">密码错误，请重试。</p>' : ''}
  <form method="post" action="/login">
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
    <button type="submit">进入</button>
  </form>
</main>
</body>
</html>`;
}
/** Read a login form body, refusing anything over the size cap. */
async function readLoginBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const part = chunk;
        total += part.length;
        if (total > LOGIN_BODY_LIMIT_BYTES)
            return null;
        chunks.push(part);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
/** Test hook: session-token and comparison primitives with an injectable clock. */
export const internals = { signToken, validToken, safeEqual };
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
export function apply(ctx, config) {
    const password = config.password ?? '';
    if (password === '')
        return;
    const secret = config.secret ?? randomBytes(32).toString('base64url');
    const ttlMs = config.sessionTtlSeconds * 1000;
    ctx.inject(['webServer'], (serverCtx) => {
        const authed = (req) => validToken(secret, sessionCookie(req.headers.cookie), Date.now());
        const deny = (res) => {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('unauthorized');
        };
        const gate = (req, res, kind) => {
            const pathname = new URL(req.url ?? '/', 'http://x').pathname;
            if (pathname === LOGIN_PATH)
                return true;
            if (authed(req))
                return true;
            if (kind === 'upgrade'
                || pathname === API_PATH || pathname.startsWith(`${API_PATH}/`)
                || (req.method !== 'GET' && req.method !== 'HEAD')) {
                deny(res);
                return false;
            }
            res.writeHead(302, { location: LOGIN_PATH });
            res.end();
            return false;
        };
        const loginHandler = async (req, res) => {
            if (req.method === 'GET') {
                if (authed(req)) {
                    res.writeHead(302, { location: '/' });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(loginPage(false));
                return;
            }
            if (req.method === 'POST') {
                if (authed(req)) {
                    res.writeHead(302, { location: '/' });
                    res.end();
                    return;
                }
                const form = await readLoginBody(req);
                if (form !== null && safeEqual(form.get('password') ?? '', password)) {
                    res.writeHead(302, {
                        location: '/',
                        'set-cookie': `${COOKIE_NAME}=${signToken(secret, ttlMs)}; Path=/; HttpOnly; SameSite=Strict`,
                    });
                    res.end();
                    return;
                }
                res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
                res.end(loginPage(true));
                return;
            }
            res.writeHead(405);
            res.end();
        };
        serverCtx.effect(() => serverCtx.webServer.registerGate(gate), 'web-auth: request gate');
        serverCtx.effect(() => serverCtx.webServer.register({ kind: 'exact', path: LOGIN_PATH, handler: loginHandler }), 'web-auth: /login route');
    });
}
//# sourceMappingURL=web-auth.js.map