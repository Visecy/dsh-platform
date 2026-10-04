/**
 * @visecy/dsh-logging-stdout
 *
 * The platform's stdout sink for `ctx.logger`.
 *
 * Why this row exists: cordis's own exporter only ring-buffers messages in
 * memory (nothing reads that buffer), and `dsh-app-boot`'s exporter keeps
 * warn/error in memory for its StartupError path and writes them to a file
 * only when startup FAILS. In the shipped composition there is therefore no
 * sink at all: every `ctx.logger.warn` / `.error` from a platform plugin is
 * dropped, which has cost this project multiple debugging cycles (a fix that
 * silently did nothing looks identical to a fix that worked). With this row
 * mounted, the same line lands on process STDOUT and is diagnosable from
 * `kubectl logs`.
 *
 * Design constraints, all deliberate:
 *
 *  - STDOUT only, never a file: the control plane runs with
 *    `readOnlyRootFilesystem` and nothing durable may live under `DSH_HOME`.
 *  - The level threshold is the row's `level` config and defaults to `warn`:
 *    a boot emits a steady stream of info lines (plugin mount, hmr, listener
 *    banners) that would drown the actionable signal in a pod log, while every
 *    platform plugin reports failures through warn/error. `info`/`debug` are
 *    one config edit away when a specific problem is being chased.
 *  - Exactly one line per message: one exporter per root context,
 *    reference-counted, so a second mount of this row (or an overlay patch)
 *    cannot duplicate output.
 *  - No dependency on any other platform package, and no filesystem access:
 *    this row must stay loadable even when the rest of the platform is broken
 *    — that is precisely when its output is needed most.
 *
 * It deliberately does not replay cordis's in-memory ring buffer: the sink is
 * live from its mount onward. The pre-mount window is the startup-error path's
 * business (`dsh-app-boot` collects it for the StartupError report), and
 * replaying it would print stale, out-of-order records.
 * @module @visecy/dsh-logging-stdout
 */
import { Context, type Message } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { formatWithOptions } from 'node:util'

export const name = '@visecy/dsh-logging-stdout'

/** Severity names accepted by the row's `level` config. */
export type Level = 'error' | 'warn' | 'info' | 'debug'

/**
 * Row config. `level` is the LEAST severe message type written; `error` is
 * always written. The default `warn` keeps normal operation quiet while
 * surfacing every warn/error (see the module doc).
 */
export const Config = z.object({
  level: z.union(['error', 'warn', 'info', 'debug'] as const).default('warn'),
})
export type Config = { level?: Level }

/** Severity ranks: a message is written when its rank is at most the threshold's. */
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/** Fixed-width labels keep the level column stable and grep-able. */
const LABEL: Record<Level, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
}

/**
 * One sink per root context, reference-counted so that a second mount of this
 * row cannot double every line, and so disposing one fiber does not silence a
 * sink another fiber still holds. `Symbol.for` keeps the key shared even if
 * two copies of this module are ever loaded in one process.
 */
const SINK = Symbol.for('@visecy/dsh-logging-stdout/sink')

interface Sink {
  refs: number
  dispose: () => void
}

type Root = Context & { [SINK]?: Sink }

/**
 * Render one log record. `util.format` is the same substitution `console.log`
 * uses, so `%s`/`%o` placeholders and Error stacks read as operators expect.
 */
function render(message: Message): string {
  const text = formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...message.args)
  return `${new Date(message.ts).toISOString()} ${LABEL[message.type]} ${message.name}: ${text}\n`
}

export function apply(ctx: Context, config: Config = {}): void {
  const threshold = RANK[config?.level ?? 'warn']
  const root = ctx.root as Root
  const existing = root[SINK]
  if (existing !== undefined) {
    existing.refs += 1
    ctx.effect(() => () => release(root, existing))
    return
  }
  const dispose = root.logger.exporter({
    // Registered on the ROOT context, not on this row's fiber: `exporter()`
    // ties the sink to the registering fiber, and a sink that dies with the
    // first of two mounted rows would go dark while the other still holds it.
    // The root fiber lives as long as the process, and `release` below is what
    // removes the exporter once the last holder is gone.
    //
    // Everything reaches `export`: cordis's numeric `levels` filter is NOT
    // severity-ordered (its INFO threshold of 1 already drops warn), so the
    // threshold is applied here, where the levels keep their real order.
    levels: { default: RANK.debug },
    export: (message) => {
      if (RANK[message.type] > threshold) return
      try {
        process.stdout.write(render(message))
      } catch {
        // A closed stdout (EPIPE on a rotated pipe) must not break the plugin
        // that logged, and there is no other channel left to report it on.
      }
    },
  })
  const sink: Sink = { refs: 1, dispose: () => void dispose() }
  root[SINK] = sink
  ctx.effect(() => () => release(root, sink))
}

/** Drop one reference; the last holder removes the exporter. */
function release(root: Root, sink: Sink): void {
  sink.refs -= 1
  if (sink.refs > 0) return
  delete root[SINK]
  sink.dispose()
}
