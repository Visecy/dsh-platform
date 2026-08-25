#!/usr/bin/env node
/** Add @visecy/dsh-workspace-k8s client bundle to the web profile's bundle stack. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const profileDir = process.argv[2] ?? '/opt/dsh-home/profiles/web'
const pkgPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!bundles.includes('@visecy/dsh-workspace-k8s')) {
  bundles.push('@visecy/dsh-workspace-k8s')
}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = bundles
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('enabled @visecy/dsh-workspace-k8s client bundle in web profile bundles')
