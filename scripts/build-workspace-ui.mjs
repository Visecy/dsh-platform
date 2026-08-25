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
const root = resolve(here, '..', 'packages', 'workspace-k8s')
const clientSrc = join(root, 'src/client/index.tsx')
if (!existsSync(clientSrc)) {
  console.error(`workspace-k8s client UI: source missing: ${clientSrc}`)
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
  entryPoints: [clientSrc],
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
    js: 'window.__ModuleLoader__.load({ id: "@visecy/dsh-workspace-k8s", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'warning',
})

console.log('built @visecy/dsh-workspace-k8s client UI -> lib/client.js')
