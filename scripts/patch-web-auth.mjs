#!/usr/bin/env node
/**
 * patch-web-auth.mjs
 *
 * dsh-web-auth@0.1.0 already carries indexTaps and applyIndexTaps, but was
 * forked before DSH 0.1.1 added collectIndexInjections/renderIndex to the
 * webServer surface. dsh-host-frontend-static calls ctx.webServer.renderIndex(),
 * so backport those two methods plus the row-rendering helpers.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (!file) throw new Error('usage: node patch-web-auth.mjs <webserver.js>')

const source = readFileSync(file, 'utf8')
if (source.includes('renderIndex(html)')) {
  console.log('[patch-web-auth] already patched')
  process.exit(0)
}

const helpers = `
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
      markup: '<script>globalThis[' + JSON.stringify(row.name).replaceAll('<', '\\\\u003c') + '] = ' + (row.value === void 0 ? 'undefined' : JSON.stringify(row.value).replaceAll('<', '\\\\u003c')) + '<\\/script>'
    };
    case 'script': return { placement: row.placement, markup: '<script>' + row.text + '<\\/script>' };
    case 'script-src': return { placement: row.placement, markup: '<script src="' + escapeHtmlAttribute(row.src) + '"><\\/script>' };
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
    const open = /<head(?:\\s[^>]*)?>/i.exec(out);
    out = open === null ? head + out : splice(out, open.index + open[0].length, head);
  }
  if (body !== '') {
    const open = /<body(?:\\s[^>]*)?>/i.exec(out);
    out = open === null ? out + body : splice(out, open.index + open[0].length, body);
  }
  return out;
}
`

const methods = `
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
`

let patched = source.replace('export class WebServer extends Service {', helpers + 'export class WebServer extends Service {')
const marker = '\n}\n/**\n * The raw-socket response adapter'
if (!patched.includes(marker)) throw new Error('patch-web-auth: class-closing marker not found')
patched = patched.replace(marker, methods + '\n}\n\n/**\n * The raw-socket response adapter')
writeFileSync(file, patched)
const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
if (check.status !== 0) {
  console.error('[patch-web-auth] syntax check failed:', check.stderr)
  process.exit(1)
}
console.log('[patch-web-auth] ok: backported collectIndexInjections/renderIndex')
