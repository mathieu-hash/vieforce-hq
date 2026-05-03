import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const testsDir = join(__dirname, '..', 'tests')
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(testsDir, f))

if (!files.length) {
  console.error('No *.test.js files in tests/')
  process.exit(1)
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
