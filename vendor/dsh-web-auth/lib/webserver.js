/**
 * @deepseek-ai/dsh-host-webserver — Web route-registration plugin: a node:http
 * server plus the `webServer` service (HTTP and upgrade route registries,
 * index transform taps, and the single fallback seat for everything no route
 * claims). Knows no harness concepts and serves no files; the composing
 * application's frontend plugin owns dist serving through the fallback hook.
 * Web shape only — Electron loads dist over file:// and carries fetch over an
 * IPC bridge. This package never prints: the URL line belongs to the shell.
 */
import { createServer, STATUS_CODES } from 'node:http';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */

/** Backport: structured index-injection helpers from dsh-host-webserver 0.1.1. */
function escapeHtmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function assertNever(row) {
  throw new Error('webserver: unknown index injection row ' + JSON.stringify(row));
}
function renderRow(row) {
  switch (row.kind) {
    case 'global': return {
      placement: 'head',
      markup: '<script>globalThis[' + JSON.stringify(row.name).replaceAll('<', '\\u003c') + '] = ' + (row.value === void 0 ? 'undefined' : JSON.stringify(row.value).replaceAll('<', '\\u003c')) + '<\/script>'
    };
    case 'script': return { placement: row.placement, markup: '<script>' + row.text + '<\/script>' };
    case 'script-src': return { placement: row.placement, markup: '<script src="' + escapeHtmlAttribute(row.src) + '"><\/script>' };
    case 'style': return { placement: 'head', markup: '<style>' + row.text + '</style>' };
    case 'html': return { placement: row.placement, markup: row.html };
    default: return assertNever(row);
  }
}
function splice(html, at, markup) {
  return html.slice(0, at) + markup + html.slice(at);
}
function renderIndexInjections(html, rows) {
  let head = '';
  let body = '';
  for (const row of rows) {
    const rendered = renderRow(row);
    if (rendered.placement === 'head') head += rendered.markup;
    else body += rendered.markup;
  }
  let out = html;
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out);
    out = open === null ? head + out : splice(out, open.index + open[0].length, head);
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out);
    out = open === null ? out + body : splice(out, open.index + open[0].length, body);
  }
  return out;
}
export class WebServer extends Service {
    config;
    static Config = z.object({
        host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
        port: z.natural().max(65535).required(),
    });
    exact = new Map();
    prefixes = new Map();
    upgrades = new Map();
    upgradedSockets = new Set();
    indexTaps = [];
    fallback;
    gate;
    server;
    listenedPort;
    constructor(ctx, config) {
        super(ctx, 'webServer');
        this.config = config;
    }
    /** The listening port (the OS-assigned value when config.port is 0). */
    get port() {
        return this.listenedPort;
    }
    /** The configured bind host (the loopback or all-interfaces literal). */
    get host() {
        return this.config.host;
    }
    /**
     * Register a named route. Duplicate (kind, path) throws — route patterns are
     * a composition-level contract, so a collision is a misconfiguration.
     * @param route - kind, path, and the owning handler.
     * @returns the disposer removing the route.
     */
    register(route) {
        const table = route.kind === 'exact' ? this.exact : this.prefixes;
        if (table.has(route.path)) {
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        table.set(route.path, route);
        return () => { table.delete(route.path); };
    }
    /**
     * Register an exact-path HTTP upgrade route. Duplicate paths throw because
     * one socket can have only one protocol owner.
     * @param route - pathname and handler owning negotiation plus socket use.
     * @returns the disposer removing the route.
     */
    registerUpgrade(route) {
        if (this.upgrades.has(route.path)) {
            throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
        }
        this.upgrades.set(route.path, route);
        return () => { this.upgrades.delete(route.path); };
    }
    /**
     * Claim the fallback seat: the handler answering every request no named
     * route matches (the SPA dist server in the shipped Web composition). One
     * owner only — a second registration throws, because two fallbacks cannot
     * compose.
     * @param handler - owns the full response lifecycle of unmatched requests.
     * @returns the disposer releasing the seat.
     */
    registerFallback(handler) {
        if (this.fallback !== undefined) {
            throw new Error('webserver: fallback already registered');
        }
        this.fallback = handler;
        return () => { this.fallback = undefined; };
    }
    /**
     * Claim the request-gate seat: the handler deciding whether every request —
     * named routes, the fallback, and HTTP upgrades — may proceed to dispatch.
     * One owner only — a second registration throws, because gates cannot
     * compose. The gate runs before route matching, so a whitelist inside the
     * gate (the login page a password gate serves) reaches its own named route.
     * @param gate - decides dispatch; on denial it owns writing the response.
     * @returns the disposer releasing the seat.
     */
    registerGate(gate) {
        if (this.gate !== undefined) {
            throw new Error('webserver: gate already registered');
        }
        this.gate = gate;
        return () => { this.gate = undefined; };
    }
    /**
     * Register an index.html transform, applied by the fallback owner to every
     * index response ({@link applyIndexTaps}) in registration order.
     * @param transform - pure html-to-html function.
     * @returns the disposer removing the transform.
     */
    tapIndex(transform) {
        this.indexTaps.push(transform);
        return () => {
            const at = this.indexTaps.indexOf(transform);
            if (at !== -1)
                this.indexTaps.splice(at, 1);
        };
    }
    /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
    async [Service.init]() {
        const handle = async (req, res) => {
            // The gate runs before route matching; a denial owns the response, so
            // dispatch stops here.
            const gate = this.gate;
            if (gate !== undefined && !(await gate(req, res, 'request')))
                return;
            /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
            requests; the field is only optional on the client-side IncomingMessage type */
            const rawPath = new URL(req.url ?? '/', 'http://x').pathname;
            const route = this.match(rawPath);
            if (route !== undefined) {
                await route.handler(req, res);
                return;
            }
            const fallback = this.fallback;
            if (fallback === undefined) {
                res.writeHead(404);
                res.end();
                return;
            }
            await fallback(req, res);
        };
        // Last-resort guard: handle() rejecting would otherwise be an unhandled
        // rejection killing the process on one malformed request (bad %-escape,
        // client dropping mid-body). Per-request failures log and answer 400 —
        // never a process exit.
        this.server = createServer((req, res) => {
            handle(req, res).catch((err) => {
                this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)));
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                res.writeHead(400);
                res.end();
            });
        });
        this.server.on('upgrade', (req, socket, head) => {
            const onError = (error) => {
                this.ctx.logger.warn(error);
                socket.destroy();
            };
            socket.on('error', onError);
            socket.once('close', () => {
                socket.off('error', onError);
                this.upgradedSockets.delete(socket);
            });
            const gate = this.gate;
            if (gate === undefined) {
                this.dispatchUpgrade(req, socket, head);
                return;
            }
            // The gate decides before protocol negotiation; on denial it owns the
            // socket through the raw-response adapter. A throwing gate destroys the
            // socket — never a process exit.
            try {
                Promise.resolve(gate(req, upgradeGateResponse(socket), 'upgrade')).then((allowed) => {
                    if (allowed)
                        this.dispatchUpgrade(req, socket, head);
                }, (error) => {
                    this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
                    socket.destroy();
                });
            }
            catch (error) {
                this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
                socket.destroy();
            }
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.port, this.config.host, () => {
                this.server.off('error', reject);
                this.server.on('error', (err) => { this.ctx.logger.error(err); });
                this.listenedPort = this.server.address().port;
                resolve();
            });
        });
        // Node does not include upgraded sockets in closeAllConnections(). The service
        // owns them with the other connections, so it tracks and destroys them explicitly.
        this.ctx.effect(() => async () => {
            const serverClosed = new Promise((resolve) => {
                this.server.close(() => { resolve(); });
            });
            this.server.closeAllConnections();
            const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise((resolve) => {
                socket.once('close', () => { resolve(); });
                socket.destroy();
            }));
            await Promise.all([serverClosed, ...upgradedClosed]);
        }, 'webServer.listen');
    }
    /** Longest-prefix-wins over the prefix table after an exact-table miss. */
    match(pathname) {
        const exact = this.exact.get(pathname);
        if (exact !== undefined)
            return exact;
        let best;
        for (const [prefix, route] of this.prefixes) {
            if (pathname !== prefix && !pathname.startsWith(`${prefix}/`))
                continue;
            if (best === undefined || prefix.length > best.path.length)
                best = route;
        }
        return best;
    }
    /** Match an upgrade pathname to its exact route, own the socket, and dispatch. */
    dispatchUpgrade(req, socket, head) {
        let route;
        try {
            /* v8 ignore next -- node:http always sets url on server requests. */
            route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname);
        }
        catch (error) {
            this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
            socket.destroy();
            return;
        }
        if (route === undefined) {
            socket.destroy();
            return;
        }
        this.upgradedSockets.add(socket);
        try {
            Promise.resolve(route.handler(req, socket, head)).catch((error) => {
                this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
                socket.destroy();
            });
        }
        catch (error) {
            this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
            socket.destroy();
        }
    }
    /**
     * Run an index.html body through the registered taps in registration order
     * — called by the fallback owner on every index response it renders.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    applyIndexTaps(html) {
        let out = html;
        for (const transform of this.indexTaps)
            out = transform(out);
        return out;
    }
  /**
   * Backport: gather the structured index-injection table.
   */
  collectIndexInjections() {
    const table = [];
    this.ctx.emit('webserver/index-inject', table);
    return table;
  }
  /**
   * Backport: render one index.html body.
   */
  renderIndex(html) {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()));
  }

}

/**
 * The raw-socket response adapter handed to a request gate on an upgrade: no
 * `ServerResponse` exists before protocol negotiation, so the gate's denial
 * writes a plain HTTP/1.1 response to the socket instead. Headers assemble in
 * writeHead/setHeader call order under the status line and flush on end.
 * @param socket - raw socket transferred by the HTTP server.
 * @returns the response surface the gate writes.
 */
function upgradeGateResponse(socket) {
    let statusLine;
    const headerLines = [];
    return {
        writeHead(statusCode, headers = {}) {
            statusLine = `HTTP/1.1 ${String(statusCode)} ${STATUS_CODES[statusCode] ?? ''}`;
            for (const [name, value] of Object.entries(headers)) {
                for (const part of Array.isArray(value) ? value : [value])
                    headerLines.push(`${name}: ${part}`);
            }
        },
        setHeader(name, value) {
            headerLines.push(`${name}: ${value}`);
        },
        end(body = '') {
            const lines = [
                statusLine ?? 'HTTP/1.1 200 OK',
                ...headerLines,
                'Connection: close',
                `Content-Length: ${String(Buffer.byteLength(body))}`,
                '',
                '',
            ];
            socket.end(lines.join('\r\n') + body);
        },
    };
}
export default WebServer;
//# sourceMappingURL=webserver.js.map