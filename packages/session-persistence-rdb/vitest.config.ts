import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// vitest 2.1 / vite 5.0 on Node 24 cannot externalize the `node:sqlite`
// builtin from transformed spec modules ("Failed to load url sqlite"), so
// route it through a CJS require shim. Host runtime is unaffected.
export default defineConfig({
  resolve: {
    alias: { "node:sqlite": resolve(__dirname, "src/__tests__/testing/sqlite-shim.ts") },
  },
  test: {},
});
