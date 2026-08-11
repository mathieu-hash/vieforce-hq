// Pull the live net_bridge payload and render the real front-end module against it
// into a standalone HTML file, so the panel can be eyeballed before deploying.
//   node scripts/preview-netbridge.mjs   ->  _netbridge_preview.html
import dotenv from 'dotenv'
import fs from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
dotenv.config({ path: new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
const handler = require('../api/margin-explorer.js')

const token = process.env.HQ_SERVICE_TOKEN
const body = await new Promise((resolve, reject) => {
  const req = { method: 'GET', query: { period: 'MTD', compare: 'pp', include: 'dissection' }, headers: { authorization: 'Bearer ' + token } }
  const res = { setHeader() {}, status() { return this }, end() {}, json(b) { resolve(b) } }
  handler(req, res).catch(reject)
})

const nb = body.dissection && body.dissection.net_bridge
if (!nb || !nb.available) { console.error('net_bridge unavailable:', nb && nb.reason); process.exit(1) }
fs.writeFileSync(new URL('../_netbridge_payload.json', import.meta.url), JSON.stringify(nb, null, 2))

const mod = fs.readFileSync(new URL('../js/margin-explorer-netbridge.js', import.meta.url), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Net bridge preview</title>
<style>
:root{--text:#e8eef5;--text2:#9fb0c3;--text3:#6b7e93;--surface-solid:#131a22;--surface2:rgba(255,255,255,.04);--glass-border:rgba(255,255,255,.12);--r-lg:12px}
body{background:#0b1016;color:var(--text);font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px}
.mexp-panel{background:var(--surface-solid);border:1px solid var(--glass-border);border-radius:var(--r-lg);padding:18px 20px;margin-bottom:18px}
.mexp-panel-h{margin-bottom:14px}.mexp-panel-t{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.mexp-panel-st{display:block;font-size:11px;color:var(--text3);margin-top:3px}
.mexp-recon{color:#22c55e;margin-left:8px;font-weight:600}
</style></head><body>
<div class="mexp-panel mexp-net-panel" id="mexp-net-panel" style="display:none">
  <div class="mexp-panel-h"><div class="mexp-panel-hcol">
    <span class="mexp-panel-t">GM/ton Bridge — NET of off-invoice discount</span>
    <span class="mexp-panel-st" id="mexp-net-sub">Realised margin: line GP less the document trade discount (OINV.DiscSum), which is excluded from GrssProfit</span>
  </div></div>
  <div id="mexp-net-body"></div>
</div>
<script>${mod}</script>
<script>window.MEXP_renderNetBridge(${JSON.stringify(nb)});</script>
</body></html>`
fs.writeFileSync(new URL('../_netbridge_preview.html', import.meta.url), html)
console.log('wrote _netbridge_preview.html and _netbridge_payload.json')
console.log('  delta reported', nb.vs_reported.delta_reported, '-> net', nb.vs_reported.delta_net)
console.log('  price reported', nb.vs_reported.price_reported, '-> net', nb.price)
console.log('  windows', nb.window.base_window.join('..'), 'vs', nb.window.compare_window.join('..'),
  '|', nb.window.base_shipping_days, 'vs', nb.window.compare_shipping_days, 'shipping days')
process.exit(0)
