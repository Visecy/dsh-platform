/**
 * @visecy/dsh-web-auth — the DeepSeek Harness Web webserver fork: official
 * `dsh-host-webserver` 0.1.2 surface (route/upgrade/fallback registries,
 * structured index injections incl. script-preload and the boot-readiness
 * tail, optional gzip) plus the platform request-gate extension used by
 * dsh-auth-oidc (registerGate; the gate runs before route matching and before
 * upgrade dispatch and owns denial responses).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServer;
    }
}
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
/** One named route registration. */
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns protocol negotiation and the upgraded socket after dispatch. */
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
/** The dispatch kind a request-gate decision sees. */
export type WebRequestKind = 'request' | 'upgrade';
/**
 * The response surface a request gate may write when it denies a request.
 * HTTP requests receive the real `ServerResponse`; upgrade requests receive
 * an adapter that writes a raw HTTP/1.1 response to the socket and ends it —
 * the rejection still carries status and headers (the redirect a login gate
 * needs) even though no protocol is negotiated.
 */
export interface WebGateResponse {
    writeHead(statusCode: number, headers?: Record<string, string | string[]>): void;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}
/**
 * One request-gate handler: decides whether a request may proceed to
 * dispatch. Runs before route matching on every request and before upgrade
 * route lookup on every upgrade; returning true continues dispatch, returning
 * false means the gate already wrote the response (or ended the socket).
 */
export type WebRequestGate = (req: IncomingMessage, res: WebGateResponse, kind: WebRequestKind) => boolean | Promise<boolean>;
/** Document region a rendered row lands in: after the opening head or body tag. */
export type IndexInjectionPlacement = 'head' | 'body';
/** One structured index injection row (official dsh-host-webserver 0.1.2 shape). */
export type IndexInjection =
    /** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
    { kind: 'global'; name: string; value: unknown }
    /** Inline classic script. `text` must not contain `</script`, which would close the element early. */
    | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
    /** External classic script, executed in table order (parser-blocking when served). */
    | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
    /** Advisory preload for an external classic script; static workers may ignore it. */
    | { kind: 'script-preload'; src: string }
    /** A `<style>` element in the head. `text` must not contain `</style`. */
    | { kind: 'style'; text: string }
    /** Raw markup fragment. */
    | { kind: 'html'; placement: IndexInjectionPlacement; html: string };
/** Gateway config: the listen address plus optional response gzip. */
export interface Config {
    /** Listen host; the two supported values are loopback and all-interfaces. */
    host: '127.0.0.1' | '0.0.0.0';
    /** Listen port; zero requests an OS-assigned port. */
    port: number;
    /** Response compression; default `none`. */
    compression?: 'none' | 'gzip';
    /** gzip level when `compression: 'gzip'`; default 1. */
    compressionLevel?: number;
    /** gzip threshold in bytes; default 1024. */
    compressionThresholdBytes?: number;
}
/**
 * The browser HTTP carrier service. Activation listens immediately. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers. A listen failure rejects
 * initialization, and the boot process reports the failed fiber.
 */
export declare class WebServer extends Service {
    private config;
    static Config: z<Config>;
    private readonly exact;
    private readonly prefixes;
    private readonly upgrades;
    private readonly upgradedSockets;
    private readonly indexTaps;
    private fallback;
    private gate;
    private server;
    private gzip;
    private listenedPort;
    constructor(ctx: Context, config: Config);
    /** The listening port (the OS-assigned value when config.port is 0). */
    get port(): number;
    /** The configured bind host (the loopback or all-interfaces literal). */
    get host(): Config['host'];
    /**
     * Register a named route. Duplicate (kind, path) throws — route patterns are
     * a composition-level contract, so a collision is a misconfiguration.
     * @param route - kind, path, and the owning handler.
     * @returns the disposer removing the route.
     */
    register(route: WebRoute): () => void;
    /**
     * Register an exact-path HTTP upgrade route. Duplicate paths throw because
     * one socket can have only one protocol owner.
     * @param route - pathname and handler owning negotiation plus socket use.
     * @returns the disposer removing the route.
     */
    registerUpgrade(route: WebUpgradeRoute): () => void;
    /**
     * Claim the fallback seat: the handler answering every request no named
     * route matches (the SPA dist server in the shipped Web composition). One
     * owner only — a second registration throws, because two fallbacks cannot
     * compose.
     * @param handler - owns the full response lifecycle of unmatched requests.
     * @returns the disposer releasing the seat.
     */
    registerFallback(handler: WebRoute['handler']): () => void;
    /**
     * Claim the request-gate seat: the handler deciding whether every request —
     * named routes, the fallback, and HTTP upgrades — may proceed to dispatch.
     * One owner only — a second registration throws, because gates cannot
     * compose. The gate runs before route matching, so a whitelist inside the
     * gate (the login page a password gate serves) reaches its own named route.
     * @param gate - decides dispatch; on denial it owns writing the response.
     * @returns the disposer releasing the seat.
     */
    registerGate(gate: WebRequestGate): () => void;
    /**
     * Register an index.html transform, applied by the fallback owner to every
     * index response ({@link applyIndexTaps}) in registration order.
     * @param transform - pure html-to-html function.
     * @returns the disposer removing the transform.
     */
    tapIndex(transform: (html: string) => string): () => void;
    /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
    [Service.init](): Promise<void>;
    /** Longest-prefix-wins over the prefix table after an exact-table miss. */
    private match;
    /** Match an upgrade pathname to its exact route, own the socket, and dispatch. */
    private dispatchUpgrade;
    /**
     * Run an index.html body through the registered taps in registration order
     * — called by the fallback owner on every index response it renders.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    applyIndexTaps(html: string): string;
    /**
     * Gather the structured injection table: one `webserver/index-inject` emit,
     * every subscriber pushes its current rows. Fresh per call.
     * @returns rows in subscriber activation order.
     */
    collectIndexInjections(): IndexInjection[];
    /**
     * Render one index.html body: the structured injection table first, then
     * the raw `tapIndex` transforms over the result.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    renderIndex(html: string): string;
}
/**
 * Render rows into an index.html body: head rows immediately after the
 * opening head tag, body rows immediately after the opening body tag, each
 * group in table order, and the boot-readiness tail after the last body row.
 */
export declare function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string;
export default WebServer;
