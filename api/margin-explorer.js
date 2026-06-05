// GET /api/margin-explorer — Margin Explorer (dynamic gross-margin analysis cockpit)
//
// PHASE 1 — LIVE gross-margin engine. Validated 2026-06-05: base totals reconcile to
// the _margin_audit headline (Jan-May 2026: PHP2,686M rev / 525.9M GP / 81,830 t / 6.43/kg)
// and every group-by dimension matches FINDINGS.md.
//
// Margin model: revenue=INV1.LineTotal, GP=INV1.GrssProfit (net of line discount),
// kg=INV1.InvQty (base UoM), tons=kg/1000, gm/kg=GP/kg. CANCELED='N' (cancelled pairs
// double-book). Scope OITM.ItmsGrpCod IN (103,105,102). Region=INV1.OcrCode2 (L-/V-/M-),
// BU=OCRD.GroupCode->OCRG (real, not the proxy classifier).
//
// Phase 2 (separate): COGS split RM/Packaging/Feedtag from production orders (OWOR/WOR1).
// Spec: docs/superpowers/specs/2026-06-05-margin-explorer-design.md · SQL: margin-explorer-SQL.md

const { query, queryDateRange, MIGRATION_CUTOFF } = require('./_db')
const { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')
const bridge = require('./lib/margin_bridge')

// group_by key -> validated SQL fragment (select expr + group expr + extra joins).
// User input only selects a key; never reaches SQL as a string.
const REGION_CASE = `CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END`
const DIMS = {
  region:      { sel: REGION_CASE,    grp: REGION_CASE,                   joins: '' },
  bu:          { sel: 'G.GroupName',  grp: 'G.GroupName',                 joins: 'LEFT JOIN OCRD C ON T0.CardCode=C.CardCode LEFT JOIN OCRG G ON C.GroupCode=G.GroupCode' },
  dsm:         { sel: 'S.SlpName',    grp: 'S.SlpName',                   joins: 'LEFT JOIN OSLP S ON T0.SlpCode=S.SlpCode' },
  brand:       { sel: 'LB.Name',      grp: 'LB.Name',                     joins: 'LEFT JOIN [@OITMBRAND] LB ON I.U_brands=LB.Code' },
  species:     { sel: 'LSP.Name',     grp: 'LSP.Name',                    joins: 'LEFT JOIN [@OITMSPCS] LSP ON I.U_SPECIE=LSP.Code' },
  sales_group: { sel: 'LSG.Name',     grp: 'LSG.Name',                    joins: 'LEFT JOIN [@OITMSG] LSG ON I.U_SALES_GROUP=LSG.Code' },
  ssg:         { sel: 'LSSG.Name',    grp: 'LSSG.Name',                   joins: 'LEFT JOIN [@OITMSSG] LSSG ON I.U_SSG=LSSG.Code' },
  customer:    { sel: 'T0.CardName',  grp: 'T0.CardCode, T0.CardName',    joins: '' },
  sku:         { sel: 'T1.Dscription',grp: 'T1.ItemCode, T1.Dscription',  joins: '' }
}
const DEFAULT_GROUP_BY = 'sales_group'
const REGION_PREFIX = { Luzon: 'L-%', Visayas: 'V-%', Mindanao: 'M-%' }

const norm = (v, allow, def) => { const k = String(v || '').trim().toLowerCase(); return allow.includes(k) ? k : def }
const normRegion = (r) => { const v = String(r || 'ALL').trim(); return /^(luzon|visayas|mindanao|other)$/i.test(v) ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : 'ALL' }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = (await verifySession(req)) || (await verifyServiceToken(req))
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const period = String(req.query.period || 'YTD').toUpperCase()
  const refMonthKey = (typeof req.query.ref_month === 'string' && /^\d{4}-\d{2}$/.test(req.query.ref_month.trim())) ? req.query.ref_month.trim() : 'live'
  const region = normRegion(req.query.region)
  const bu = (typeof req.query.bu === 'string' && req.query.bu.trim() && req.query.bu.trim().toUpperCase() !== 'ALL') ? req.query.bu.trim() : 'ALL'
  const customer = (typeof req.query.customer === 'string' && req.query.customer.trim()) ? req.query.customer.trim() : null
  const groupBy = DIMS[norm(req.query.group_by, Object.keys(DIMS), DEFAULT_GROUP_BY)] ? norm(req.query.group_by, Object.keys(DIMS), DEFAULT_GROUP_BY) : DEFAULT_GROUP_BY
  const compare = norm(req.query.compare, ['pp', 'ly'], 'pp')
  const include = new Set(String(req.query.include || 'bridge,trend,movers,gap').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))

  const cacheKey = ['mexp_v1', session.id, session.role, refMonthKey, period, region, bu, customer || '-', groupBy, compare, [...include].sort().join('+')].join('_')
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const periodOpts = refMonthKey !== 'live' ? { refMonth: refMonthKey } : {}
    const { dateFrom, dateTo } = getPeriodDates(period, periodOpts)
    // comparison windows
    const ppFrom = new Date(dateFrom); ppFrom.setTime(ppFrom.getTime() - (dateTo - dateFrom))
    const ppTo = new Date(dateFrom); ppTo.setDate(ppTo.getDate() - 1)
    const lyFrom = new Date(dateFrom); lyFrom.setFullYear(lyFrom.getFullYear() - 1)
    const lyTo = new Date(dateTo); lyTo.setFullYear(lyTo.getFullYear() - 1)

    // Margin-correct filters (OcrCode2 region, OCRG bu) — NOT the warehouse/proxy helpers.
    const params = { dateFrom, dateTo }
    let f = `AND T1.OcrCode2 IS NOT NULL`
    if (region !== 'ALL') {
      if (region === 'Other') f += ` AND T1.OcrCode2 NOT LIKE 'L-%' AND T1.OcrCode2 NOT LIKE 'V-%' AND T1.OcrCode2 NOT LIKE 'M-%'`
      else { f += ` AND T1.OcrCode2 LIKE @rpref`; params.rpref = REGION_PREFIX[region] }
    }
    if (bu !== 'ALL') { f += ` AND G.GroupName = @bu`; params.bu = bu }
    if (customer) { f += ` AND (T0.CardCode = @cust OR T0.CardName LIKE @custl)`; params.cust = customer; params.custl = '%' + customer + '%' }
    const roleWhere = applyRoleFilter(session, `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'`)
    // ensure OCRD/OCRG join is present when BU is filtered/grouped
    const needsBuJoin = (bu !== 'ALL') || groupBy === 'bu'
    const buJoin = needsBuJoin && !DIMS[groupBy].joins.includes('OCRG') ? 'LEFT JOIN OCRD C ON T0.CardCode=C.CardCode LEFT JOIN OCRG G ON C.GroupCode=G.GroupCode' : ''

    const dim = DIMS[groupBy]
    const baseFrom = `FROM OINV T0 INNER JOIN INV1 T1 ON T0.DocEntry=T1.DocEntry INNER JOIN OITM I ON T1.ItemCode=I.ItemCode ${dim.joins} ${buJoin}`
    const scopeWhere = `${roleWhere} AND I.ItmsGrpCod IN (103,105,102) ${f}`

    // ---- matrix rows (current window, grouped) ----
    const rows = await query(`
      SELECT ${dim.sel} AS dim,
        ISNULL(SUM(T1.LineTotal),0) AS sales,
        ISNULL(SUM(T1.InvQty),0) AS kg,
        ISNULL(SUM(T1.GrssProfit),0) AS gp
      ${baseFrom} ${scopeWhere}
      GROUP BY ${dim.grp} HAVING SUM(T1.LineTotal) <> 0 ORDER BY gp DESC`, params)
    const totGp = rows.reduce((a, r) => a + Number(r.gp || 0), 0)
    const matrixRows = rows.map(r => {
      const sales = Number(r.sales || 0), kg = Number(r.kg || 0), gp = Number(r.gp || 0)
      return {
        dim: r.dim || '(none)', sales: Math.round(sales), kg: Math.round(kg), tons: Math.round(kg / 1000),
        gp: Math.round(gp), gp_pct: sales > 0 ? Math.round(gp / sales * 1000) / 10 : 0,
        gm_per_kg: kg > 0 ? Math.round(gp / kg * 100) / 100 : 0,
        pct_of_gp: totGp !== 0 ? Math.round(gp / totGp * 1000) / 10 : 0, expandable: groupBy !== 'sku'
      }
    })

    // ---- hero totals: current + comparison ----
    const totalsSql = `SELECT ISNULL(SUM(T1.LineTotal),0) AS sales, ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.GrssProfit),0) AS gp
      ${baseFrom} ${scopeWhere}`
    const cur = (await query(totalsSql, params))[0] || { sales: 0, kg: 0, gp: 0 }
    // comparison totals via queryDateRange so a pre-2026 window correctly reads the historical DB
    const [cmpFrom, cmpTo] = compare === 'ly' ? [lyFrom, lyTo] : [ppFrom, ppTo]
    let cmp = (await queryDateRange(totalsSql, params, cmpFrom, cmpTo))[0] || { sales: 0, kg: 0, gp: 0 }
    const mk = (c, p, kind) => {
      const cv = Number(c || 0), pv = Number(p || 0)
      const pct = pv !== 0 ? Math.round((cv - pv) / Math.abs(pv) * 1000) / 10 : null
      return { value: kind === 'round' ? Math.round(cv) : cv, delta_pct: pct }
    }
    const curGpkg = Number(cur.kg) > 0 ? Number(cur.gp) / Number(cur.kg) : 0
    const cmpGpkg = Number(cmp.kg) > 0 ? Number(cmp.gp) / Number(cmp.kg) : 0
    const hero = {
      net_sales: mk(cur.sales, cmp.sales, 'round'),
      gross_profit: mk(cur.gp, cmp.gp, 'round'),
      gp_pct: { value: Number(cur.sales) > 0 ? Math.round(Number(cur.gp) / Number(cur.sales) * 1000) / 10 : 0, delta_pp: (Number(cur.sales) > 0 && Number(cmp.sales) > 0) ? Math.round((Number(cur.gp) / Number(cur.sales) - Number(cmp.gp) / Number(cmp.sales)) * 1000) / 10 : null },
      gm_per_kg: { value: Math.round(curGpkg * 100) / 100, delta: cmpGpkg ? Math.round((curGpkg - cmpGpkg) * 100) / 100 : null },
      compare_basis: compare
    }

    // ---- bridge: current vs prior-period at SKU level (item-comparable within 2026) ----
    // Phase 1 = single COGS bucket (all in cost_rm); Phase 2 splits RM/Pkg/Feedtag via OWOR/WOR1.
    let bridgeOut = null
    if (include.has('bridge') && ppFrom < MIGRATION_CUTOFF) {
      // Prior same-length window predates the Jan-2026 consolidation → item codes not comparable.
      bridgeOut = { available: false, reason: 'Prior period predates the Jan-2026 consolidation (item codes not comparable). Select MTD or QTD for a like-for-like bridge.' }
    } else if (include.has('bridge')) {
      const itemSql = `SELECT T1.ItemCode AS item, ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.LineTotal),0) AS revenue, ISNULL(SUM(T1.GrssProfit),0) AS gp
        ${baseFrom} ${scopeWhere} GROUP BY T1.ItemCode HAVING SUM(T1.InvQty) <> 0`
      const toRows = arr => arr.map(r => { const rev = Number(r.revenue), gp = Number(r.gp); return { item: r.item, kg: Number(r.kg), revenue: rev, gp, cost_rm: rev - gp, cost_pkg: 0, cost_feedtag: 0 } })
      const cur1 = toRows(await query(itemSql, params))
      const prev0 = toRows(await query(itemSql, { ...params, dateFrom: ppFrom, dateTo: ppTo }))
      // GM/ton bridge (Mat's spec): per-unit decomposition × 1000. No volume effect (per-unit).
      const bk = bridge.bridgeGMperKg(prev0, cur1)
      const T = 1000
      bridgeOut = {
        available: true, basis: 'vs prior period · ₱/ton', unit: 'php_per_ton',
        prior_gp: Math.round((bk.gm0_perkg || 0) * T), current_gp: Math.round((bk.gm1_perkg || 0) * T),
        price: Math.round((bk.price || 0) * T), mix: Math.round((bk.mix || 0) * T),
        cost: { total: Math.round((bk.cost_total || 0) * T), rm: Math.round((bk.cost_rm || 0) * T), packaging: Math.round((bk.cost_pkg || 0) * T), feedtag: Math.round((bk.cost_feedtag || 0) * T) },
        delta_gp: Math.round((bk.delta_gm_perkg || 0) * T),
        reconciles: Math.abs(((bk.price || 0) + (bk.mix || 0) + (bk.cost_total || 0)) - (bk.delta_gm_perkg || 0)) < 0.01,
        note: 'GM/ton bridge: Price + Mix + COGS (RM/Pkg/Feedtag). Per-unit ⇒ no volume effect. Phase 1: COGS single bucket (RM); split = Phase 2.'
      }
    }

    const result = {
      meta: {
        endpoint: 'margin-explorer', sap_validated: true, data_source: 'sap_b1',
        window: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
        applied_filters: { period, ref_month: refMonthKey, region, bu, customer, group_by: groupBy, compare, include: [...include] },
        data_quality: { volume_basis: 'INV1.InvQty (kg)', region_basis: 'OcrCode2 (sales dim-2)', bu_basis: 'OCRD.GroupCode->OCRG (real)', notes: ['Pre-rebate gross profit.', 'vs-LY at customer/SKU not comparable across Jan-2026 consolidation; bridge uses prior period.'] }
      },
      hero,
      matrix: { group_by: groupBy, rows: matrixRows, total_gp: Math.round(totGp) },
      bridge: bridgeOut,
      trend: include.has('trend') ? { unit: 'gm_per_kg', ly_comparable: false, ly_suppressed_reason: 'phase1_pending', series: [] } : null,
      movers: include.has('movers') ? { basis: 'mix_contribution', items: [] } : null,
      gap: include.has('gap') ? { available: false, note: 'Phase 1: gap analysis pending' } : null
    }
    cache.set(cacheKey, result, 120)
    res.json(result)
  } catch (err) {
    console.error('API error [margin-explorer]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
