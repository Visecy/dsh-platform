#!/usr/bin/env node
/**
 * Build one plugin package to a self-contained dist/index.js bundle.
 * Works from the repo root OR from the package directory (npm run).
 * Usage: node scripts/build-pkg.mjs <package-dir> <entry>
 */
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const [, , pkgName, entry] = process.argv
if (!pkgName || !entry) {
  console.error('usage: build-pkg.mjs <package-name> <entry>')
  process.exit(1)
}

// cwd may be the repo root (pnpm -r) or the package dir (npm run)
let root = resolve(process.cwd(), 'packages', pkgName)
if (!existsSync(root)) root = process.cwd()
mkdirSync(join(root, 'dist'), { recursive: true })

await build({
  entryPoints: [join(root, entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@deepseek-ai/*', '@kubernetes/client-node'],
  outfile: join(root, 'dist', 'index.js'),
  logLevel: 'warning',
  sourcemap: false,
})
console.log(`built ${pkgName} -> dist/index.js`)
