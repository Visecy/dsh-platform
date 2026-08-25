#!/usr/bin/env node
/**
 * Build @visecy/dsh-workspace-ui:
 * - lib/index.js  host half (ESM node)
 * - lib/client.js browser module-loader closure (CJS)
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', 'packages', 'workspace-ui')
if (!existsSync(join(root, 'src/index.ts')) || !existsSync(join(root, 'src/client/index.tsx'))) {
  console.error(`workspace-ui: source missing under ${root}`)
  process.exit(1)
}
mkdirSync(join(root, 'lib'), { recursive: true })

const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar/client',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-layout/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
]

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@visecy/dsh-workspace-ui", factory: (require) => {',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'warning',
})

console.log('built @visecy/dsh-workspace-ui -> lib/index.js + lib/client.js')
