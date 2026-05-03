#!/usr/bin/env node
/**
 * Fail if service-role material appears in browser-delivered paths (js/, root *.html).
 * Server-only api/ is not scanned here.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Service role key must never appear in browser-delivered JS/HTML. */
const FORBIDDEN = [/SUPABASE_SERVICE_ROLE_KEY/]

let failed = false

function scanFile(label, text) {
  for (const re of FORBIDDEN) {
    if (re.test(text)) {
      console.error(`[ci-scan-client] FORBIDDEN pattern ${re} in ${label}`)
      failed = true
    }
  }
}

function walkJs(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) continue
    if (!name.endsWith('.js')) continue
    scanFile(p, readFileSync(p, 'utf8'))
  }
}

walkJs('js')

for (const html of ['index.html', 'app.html', 'vieforce-hq-desktop.html', 'pg-admin-team.html']) {
  if (existsSync(html)) scanFile(html, readFileSync(html, 'utf8'))
}

process.exit(failed ? 1 : 0)
