'use strict'
const { bridgeExactGMperTon, mixByDim } = require('./margin_bridge_v2')
const { nthShippingDay, fmt } = require('./margin_window')
const { countShippingDays } = require('./shipping_days')

const DIMS = { ssg: 'Feed category', region: 'Region', bu: 'BU', dsm: 'DSM / invoice rep', customer: 'Customer', sku: 'SKU', brand: 'Brand', warehouse: 'Dispatch warehouse' }
const NUMS = ['kg', 'revenue', 'gp', 'disc']
const empty = () => ({ kg: 0, revenue: 0, gp: 0, disc: 0 })
function add(a, b) { for (const k of NUMS) a[k] += Number(b[k]) || 0; return a }
function total(rows) { return rows.reduce(add, empty()) }
function metrics(x) {
  return { ...x, tons: x.kg / 1000, gm: x.kg > 0 ? x.gp / x.kg * 1000 : null,
    net: x.kg > 0 ? (x.gp - x.disc) / x.kg * 1000 : null,
    price: x.kg > 0 ? x.revenue / x.kg * 1000 : null,
    cost: x.kg > 0 ? (x.revenue - x.gp) / x.kg * 1000 : null,
    pct: x.revenue > 0 ? x.gp / x.revenue * 100 : null }
}
function monthsEnding(end) {
  const [y, m] = end.split('-').map(Number)
  return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(y, m - 12 + i, 1)).toISOString().slice(0, 7))
}
const date = s => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)) || 1)
const endMonth = m => fmt(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0))
const id = (r, d) => String(r[d] == null || r[d] === '' ? 'UNKNOWN' : r[d])
const label = (r, d) => r[d + '_name'] || id(r, d)
function match(r, filters) { return Object.entries(filters).every(([d, value]) => id(r, d) === value) }
function grouped(rows, key) {
  const map = new Map()
  for (const r of rows) { const k = key(r); if (!map.has(k)) map.set(k, { ...r, ...empty() }); add(map.get(k), r) }
  return [...map.values()]
}
function validate(q, nowMonth) {
  const asof = q.asof || nowMonth
  const months = monthsEnding(/^20\d{2}-(0[1-9]|1[0-2])$/.test(asof) ? asof : nowMonth)
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(asof) || asof > nowMonth || asof < '2026-01') throw new Error('Choose an as-of month from January 2026 through the current month.')
  const current = q.current || asof, base = q.base || months[10]
  if (!months.includes(current) || !months.includes(base) || base >= current || base < '2026-01') throw new Error('Choose two different months in order, both from January 2026 onward.')
  const group = q.group || 'ssg'
  if (!DIMS[group]) throw new Error('Unsupported grouping.')
  let filters = {}
  try { filters = JSON.parse(q.filters || '{}') } catch (_) { throw new Error('Invalid filters.') }
  if (!filters || Array.isArray(filters) || typeof filters !== 'object') throw new Error('Invalid filters.')
  for (const [k, v] of Object.entries(filters)) if (!DIMS[k] || typeof v !== 'string' || !v || v.length > 150) throw new Error('Invalid filter selection.')
  return { asof, current, base, group, filters, mode: q.mode === 'full' ? 'full' : 'same', basis: q.basis === 'net' ? 'net' : 'reported' }
}
function windows(rows, opts, today) {
  const cutoff = rows.reduce((m, r) => r.date > m ? r.date : m, '')
  const currentEnd = opts.current === today.slice(0, 7) ? (cutoff && cutoff.slice(0, 7) === opts.current ? cutoff : today) : endMonth(opts.current)
  const partial = currentEnd < endMonth(opts.current)
  const days = countShippingDays(date(opts.current + '-01'), date(currentEnd))
  const baseEnd = partial && opts.mode === 'same' ? fmt(nthShippingDay(opts.base, days)) : endMonth(opts.base)
  return { base: [opts.base + '-01', baseEnd], current: [opts.current + '-01', currentEnd], partial,
    mix_comparable: !(partial && opts.mode === 'full'), cutoff,
    note: 'Dates remain fixed across drills. Monthly history shows all posted volume in each month; bridge windows are shown separately.' }
}
function within(r, w) { return r.date >= w[0] && r.date <= w[1] }
function bridge(rows0, rows1, basis) {
  const convert = r => ({ ...r, cust: r.customer, custname: r.customer_name, name: r.sku_name,
    revenue: r.revenue - (basis === 'net' ? r.disc : 0), gp: r.gp - (basis === 'net' ? r.disc : 0) })
  return bridgeExactGMperTon(rows0.map(convert), rows1.map(convert))
}
// Row attribution of the exact customer x SKU Bennet identity, on a fixed parent denominator.
// Sum of rows = bridge delta. This is not a sum of independently re-based local bridges.
function contributions(a, b, basis) {
  const key = r => JSON.stringify([r.customer, r.sku])
  const A = new Map(grouped(a, key).filter(r => r.kg > 0).map(r => [key(r), r]))
  const B = new Map(grouped(b, key).filter(r => r.kg > 0).map(r => [key(r), r]))
  const qa = total([...A.values()]).kg, qb = total([...B.values()]).kg
  if (!qa || !qb) return []
  const margin = r => (r.gp - (basis === 'net' ? r.disc : 0)) / r.kg * 1000
  const price = r => (r.revenue - (basis === 'net' ? r.disc : 0)) / r.kg * 1000
  const center = ((total([...A.values()]).gp - (basis === 'net' ? total([...A.values()]).disc : 0)) / qa + (total([...B.values()]).gp - (basis === 'net' ? total([...B.values()]).disc : 0)) / qb) * 500
  return [...new Set([...A.keys(), ...B.keys()])].map(k => {
    const x = A.get(k), y = B.get(k), r = y || x, s0 = x ? x.kg / qa : 0, s1 = y ? y.kg / qb : 0
    const p = x && y ? (s0 + s1) / 2 * (price(y) - price(x)) : 0
    const c = x && y ? -(s0 + s1) / 2 * ((y.revenue - y.gp) / y.kg - (x.revenue - x.gp) / x.kg) * 1000 : 0
    const mix = x && y ? ((margin(x) + margin(y)) / 2 - center) * (s1 - s0) : y ? (margin(y) - center) * s1 : -(margin(x) - center) * s0
    return { customer: r.customer, customer_name: r.customer_name, sku: r.sku, sku_name: r.sku_name, price: p, cost: c, mix, value: p + c + mix, matched: !!(x && y),
      tons0: x ? x.kg / 1000 : 0, tons1: y ? y.kg / 1000 : 0,
      price0: x ? price(x) : null, price1: y ? price(y) : null,
      cost0: x ? (x.revenue - x.gp) / x.kg * 1000 : null, cost1: y ? (y.revenue - y.gp) / y.kg * 1000 : null,
      share0: s0, share1: s1 }
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
}
function componentDrills(prior, current, basis, B) {
  if (!B.available) return {}
  const convert = r => ({ ...r, cust: r.customer, custname: r.customer_name, name: r.sku_name,
    revenue: r.revenue - (basis === 'net' ? r.disc : 0), gp: r.gp - (basis === 'net' ? r.disc : 0) })
  const a = prior.map(convert), b = current.map(convert), center = (B.gm0_per_ton + B.gm1_per_ton) / 2
  const result = {}
  for (const [component, dim] of [['customer_mix', 'customer'], ['product_mix', 'sku']]) {
    const names = new Map([...prior, ...current].map(r => [String(r[dim]), r[dim + '_name'] || r[dim]]))
    const lens = mixByDim(a, b, r => String(r[dim]), null, center)
    result[component] = { dimension: dim, total: B[component], standalone_total: lens.total,
      adjustment: B[component] - lens.total, center,
      rows: lens.detail.map(r => ({ ...r, id: r.key, name: names.get(r.key) || r.key })) }
  }
  return result
}
function opportunities(rows, opts, denominator, peerRows = rows) {
  // Full prior month for sizing, never extrapolate four days into a full month.
  const base = rows.filter(r => r.date.slice(0, 7) === opts.base)
  const pairedKey = r => JSON.stringify([r.customer, r.sku, r.region, r.bu])
  const before = new Map(grouped(base, pairedKey).map(r => [pairedKey(r), r]))
  const after = new Map(grouped(rows.filter(r => r.date.slice(0, 7) === opts.current), pairedKey).filter(r => r.kg > 0).map(r => [pairedKey(r), r]))
  const peerBase = grouped(peerRows.filter(r => r.date.slice(0, 7) === opts.base), pairedKey)
  const peerCurrent = grouped(peerRows.filter(r => r.date.slice(0, 7) === opts.current), pairedKey)
  const cells = [...before.values()], candidates = []
  for (const r of cells) {
    if (r.kg < 10000 || r.revenue <= 0) continue
    const post = after.get(pairedKey(r)), current = post || r
    const peers = (post ? peerCurrent : peerBase).filter(p => p.sku === r.sku && p.region === r.region && p.bu === r.bu && p.customer !== r.customer && p.kg >= 5000)
    const peer = total(peers), ownNet = (current.revenue - current.disc) / current.kg
    const gap = peers.length >= 2 ? Math.max(0, (peer.revenue - peer.disc) / peer.kg - ownNet) : 0
    const drift = post ? Math.max(0, (post.revenue - post.gp) / post.kg - (r.revenue - r.gp) / r.kg - (post.revenue / post.kg - r.revenue / r.kg)) : 0
    const discount = current.disc / current.revenue
    const uplift = Math.max(gap / Math.max(0.01, 1 - discount), drift)
    const php = uplift * r.kg
    if (php < 20000 || !Number.isFinite(uplift)) continue
    candidates.push({ customer: r.customer, customer_name: r.customer_name, sku: r.sku, sku_name: r.sku_name,
      reason: drift >= gap / Math.max(0.01, 1 - discount) ? 'Cost increase not recovered' : 'Comparable-SKU net price gap',
      sizing_month: opts.base, tons: r.kg / 1000, price: current.revenue / current.kg, cost: (current.revenue - current.gp) / current.kg,
      net: (current.gp - current.disc) / current.kg, uplift, php, impact: denominator > 0 ? php / (denominator / 1000) : null,
      discount_rate: discount, peer_month: post ? opts.current : opts.base, peers: peers.map(p => ({ customer: p.customer, name: p.customer_name, tons: p.kg / 1000, net_price: (p.revenue - p.disc) / p.kg })),
      evidence: peers.length >= 2 ? 'SKU / region / BU matched' : 'Same customer and SKU',
      caveat: 'Indicative ceiling, not a quote. Terms, volume tiers, contracts, formula equivalence and retention need commercial validation.' })
  }
  // Different regions can overlap the same customer's SKU negotiation: keep one candidate, no portfolio total.
  const unique = new Map()
  for (const c of candidates.sort((a, b) => b.php - a.php)) if (!unique.has(c.customer + c.sku)) unique.set(c.customer + c.sku, c)
  return [...unique.values()].slice(0, 100)
}
function build(rows, opts, today) {
  const months = monthsEnding(opts.asof), W = windows(rows, opts, today)
  const selected = rows.filter(r => match(r, opts.filters)), cur = selected.filter(r => within(r, W.current)), prior = selected.filter(r => within(r, W.base))
  const groups = new Map()
  for (const r of selected) {
    const k = id(r, opts.group)
    if (!groups.has(k)) groups.set(k, { id: k, name: label(r, opts.group), cells: {}, total: empty(), current: empty(), prior: empty() })
    const g = groups.get(k), m = r.date.slice(0, 7)
    if (months.includes(m)) { add(g.cells[m] || (g.cells[m] = empty()), r); add(g.total, r) }
    if (within(r, W.current)) add(g.current, r)
    if (within(r, W.base)) add(g.prior, r)
  }
  const finish = g => ({ ...g, cells: Object.fromEntries(Object.entries(g.cells).map(([m, v]) => [m, metrics(v)])), total: metrics(g.total), current: metrics(g.current), prior: metrics(g.prior) })
  const totals = { cells: {}, total: total(selected), current: total(cur), prior: total(prior) }
  for (const r of selected) add(totals.cells[r.date.slice(0, 7)] || (totals.cells[r.date.slice(0, 7)] = empty()), r)
  const nationalBase = total(rows.filter(r => r.date.slice(0, 7) === opts.base)).kg
  const B = bridge(prior, cur, opts.basis)
  const whole0 = rows.filter(r => within(r, W.base)), whole1 = rows.filter(r => within(r, W.current))
  const parentContributions = contributions(whole0, whole1, opts.basis)
  // Only customer/SKU filters can select parent cell contributions unambiguously; other dimensions split cells.
  const parentSupported = Object.keys(opts.filters).every(k => ['customer', 'sku'].includes(k))
  return { months, dimensions: DIMS, options: opts, window: W, rows: [...groups.values()].map(finish).sort((a, b) => b.total.kg - a.total.kg), totals: finish(totals), bridge: B,
    contributors: contributions(prior, cur, opts.basis), component_drills: componentDrills(prior, cur, opts.basis, B),
    company_contribution: parentSupported ? parentContributions.filter(r => match(r, opts.filters)).reduce((s, r) => s + r.value, 0) : null,
    opportunities: opportunities(selected, opts, nationalBase, rows), national_base_tons: nationalBase / 1000,
    concentration: metrics(total(cur.filter(r => r.brand_name === 'VIETOP'))),
    note: 'Finished feed only (group 103), invoice GP less credit memos. After-document-discount margin excludes GL rebates, freight and tolling. History before Jan 2026 is unavailable in this preview. DSM means invoice salesperson; warehouse means dispatch.' }
}
module.exports = { DIMS, NUMS, metrics, total, grouped, validate, monthsEnding, windows, build, opportunities, contributions, match }
