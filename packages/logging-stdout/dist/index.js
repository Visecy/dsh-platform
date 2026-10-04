// src/index.ts
import z from "@deepseek-ai/schemastery";
import { formatWithOptions } from "node:util";
var name = "@visecy/dsh-logging-stdout";
var Config = z.object({
  level: z.union(["error", "warn", "info", "debug"]).default("warn")
});
var RANK = { error: 0, warn: 1, info: 2, debug: 3 };
var LABEL = {
  error: "ERROR",
  warn: "WARN ",
  info: "INFO ",
  debug: "DEBUG"
};
var SINK = /* @__PURE__ */ Symbol.for("@visecy/dsh-logging-stdout/sink");
function render(message) {
  const text = formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...message.args);
  return `${new Date(message.ts).toISOString()} ${LABEL[message.type]} ${message.name}: ${text}
`;
}
function apply(ctx, config = {}) {
  const threshold = RANK[config?.level ?? "warn"];
  const root = ctx.root;
  const existing = root[SINK];
  if (existing !== void 0) {
    existing.refs += 1;
    ctx.effect(() => () => release(root, existing));
    return;
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
      if (RANK[message.type] > threshold) return;
      try {
        process.stdout.write(render(message));
      } catch {
      }
    }
  });
  const sink = { refs: 1, dispose: () => void dispose() };
  root[SINK] = sink;
  ctx.effect(() => () => release(root, sink));
}
function release(root, sink) {
  sink.refs -= 1;
  if (sink.refs > 0) return;
  delete root[SINK];
  sink.dispose();
}
export {
  Config,
  apply,
  name
};
