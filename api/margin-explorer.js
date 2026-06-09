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

const { query, queryH, queryDateRange, MIGRATION_CUTOFF } = require('./_db')
const { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')
const bridge = require('./lib/margin_bridge')
const cube = require('./lib/margin_cube')

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

// Live's sellable scope (103,105,102) = Finished Goods + Trading-Import + Basemix.
// In Vienovo_Old (2025) the SAME economic basket is coded DIFFERENTLY (codes are
// scrambled across the Jan-2026 consolidation): finished feed = 103+104 (Luzon+Vismin,
// 104 ≈ 70%), basemix = 105+106, trading = 101+102. Reusing Live's codes on Old drops
// all Vismin feed (~70% undercount). See reference_sap_b1_margin_model memory.
const OLD_LY_SCOPE = '(103,104,105,106,101,102)'

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

  const cacheKey = ['mexp_v7', session.id, session.role, refMonthKey, period, region, bu, customer || '-', groupBy, compare, [...include].sort().join('+')].join('_')
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
    const [cmpFrom, cmpTo] = compare === 'ly' ? [lyFrom, lyTo] : [ppFrom, ppTo]
    // DB-aware comparison. A pre-2026 window lives in Vienovo_Old, which (a) codes the
    // sellable basket differently (OLD_LY_SCOPE) and (b) fully re-coded customers/SKUs/
    // region — so a like-for-like vs-LY only holds at the NATIONAL aggregate. For a
    // region/BU/customer slice we null the deltas rather than show a number that compares
    // a 2026 slice against a non-matching 2025 code space.
    const cmpPreCutoff = cmpTo < MIGRATION_CUTOFF
    const sliceFilterActive = (region !== 'ALL') || (bu !== 'ALL') || !!customer
    let lyComparable = true
    let cmp
    if (compare === 'ly' && cmpPreCutoff) {
      if (sliceFilterActive) {
        lyComparable = false
        cmp = { sales: 0, kg: 0, gp: 0 }   // zeros ⇒ all hero deltas resolve to null below
      } else {
        // National Old-DB totals at the Old-equivalent scope (fixes the ~70% Vismin undercount).
        const oldSql = `SELECT ISNULL(SUM(T1.LineTotal),0) AS sales, ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.GrssProfit),0) AS gp
          FROM OINV T0 INNER JOIN INV1 T1 ON T0.DocEntry=T1.DocEntry INNER JOIN OITM I ON T1.ItemCode=I.ItemCode
          ${applyRoleFilter(session, `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'`)}
          AND I.ItmsGrpCod IN ${OLD_LY_SCOPE} AND T1.OcrCode2 IS NOT NULL`
        cmp = (await queryH(oldSql, { ...params, dateFrom: cmpFrom, dateTo: cmpTo }))[0] || { sales: 0, kg: 0, gp: 0 }
      }
    } else {
      // pp (within Live), or any window that resolves post-cutoff — original path.
      cmp = (await queryDateRange(totalsSql, params, cmpFrom, cmpTo))[0] || { sales: 0, kg: 0, gp: 0 }
    }
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
      compare_basis: compare,
      ly_comparable: !(compare === 'ly' && cmpPreCutoff && sliceFilterActive),
      compare_note: (compare === 'ly' && cmpPreCutoff)
        ? (sliceFilterActive
            ? 'vs-LY unavailable for a region/BU/customer slice — 2025 (pre-consolidation) used a different customer/SKU/region coding. Clear filters for national vs-LY.'
            : 'vs-LY = national, finished-feed+trading+basemix at 2025 (Vienovo_Old) scope (feed 103+104). Aggregate only; not comparable at customer/SKU level across the Jan-2026 consolidation.')
        : null
    }

    // ---- bridge: GM/ton waterfall. Follows the selected compare basis (pp/ly). ----
    // Level dispatch:
    //   sku — prior window fully post-cutoff → item codes comparable (existing path).
    //   ssg — comparison crosses the Jan-2026 consolidation (YTD pp, or vs-LY):
    //         SSG names ([@OITMSSG]) are stable across both books, so the bridge
    //         falls back to category (SSG) level. National only — a region/BU/
    //         customer slice is NOT comparable across the cutoff (stays unavailable).
    let bridgeOut = null
    const [bFrom, bTo] = compare === 'ly' ? [lyFrom, lyTo] : [ppFrom, ppTo]
    const bridgeCrossesCutoff = bFrom < MIGRATION_CUTOFF
    const bridgeBasisLabel = compare === 'ly' ? 'vs last year' : 'vs prior period'
    if (include.has('bridge') && bridgeCrossesCutoff && sliceFilterActive) {
      bridgeOut = {
        available: false, level: null,
        reason: 'Bridge unavailable for a region/BU/customer slice across the Jan-2026 consolidation — 2025 used a different customer/SKU/region coding. Clear filters for the national category-level bridge.'
      }
    } else if (include.has('bridge') && bridgeCrossesCutoff) {
      // ---- SSG (category) level fallback — national, single Cost bucket ----
      // Prior window pre-cutoff lives in Vienovo_Old at OLD_LY_SCOPE (same DB-aware
      // scope as the vs-LY hero, commit a13861e). If it spans the cutoff, split:
      // Old part at Old scope + Live part at Live scope, merged by SSG name
      // (margin_bridge aggregates duplicate keys).
      const ssgSql = (scope) => `SELECT ISNULL(S.Name,'UNSPEC') AS ssg,
          ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.LineTotal),0) AS revenue, ISNULL(SUM(T1.GrssProfit),0) AS gp
        FROM OINV T0 INNER JOIN INV1 T1 ON T0.DocEntry=T1.DocEntry INNER JOIN OITM I ON T1.ItemCode=I.ItemCode
        LEFT JOIN [@OITMSSG] S ON I.U_SSG=S.Code
        ${applyRoleFilter(session, `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'`)}
        AND I.ItmsGrpCod IN ${scope} AND T1.OcrCode2 IS NOT NULL
        GROUP BY S.Name HAVING SUM(T1.InvQty) <> 0`
      const curSsg = await query(ssgSql('(103,105,102)'), { dateFrom, dateTo })
      let prevSsg
      if (bTo < MIGRATION_CUTOFF) {
        prevSsg = await queryH(ssgSql(OLD_LY_SCOPE), { dateFrom: bFrom, dateTo: bTo })
      } else {
        const histTo = new Date(MIGRATION_CUTOFF.getTime() - 1)
        const [h, c] = await Promise.all([
          queryH(ssgSql(OLD_LY_SCOPE), { dateFrom: bFrom, dateTo: histTo }),
          query(ssgSql('(103,105,102)'), { dateFrom: new Date(MIGRATION_CUTOFF), dateTo: bTo })
        ])
        prevSsg = [...h, ...c]
      }
      const bk = bridge.bridgeGMperKgBySsg(prevSsg, curSsg)
      const T = 1000
      bridgeOut = {
        available: true, level: 'ssg',
        basis: `${bridgeBasisLabel} · ₱/ton · category (SSG) level`, unit: 'php_per_ton',
        prior_gp: Math.round((bk.gm0_perkg || 0) * T), current_gp: Math.round((bk.gm1_perkg || 0) * T),
        price: Math.round((bk.price || 0) * T), mix: Math.round((bk.mix || 0) * T),
        cost: { total: Math.round((bk.cost_total || 0) * T) },   // single Cost bar — no RM/Pkg/Feedtag split across the cutoff
        delta_gp: Math.round((bk.delta_gm_perkg || 0) * T),
        reconciles: Math.abs(((bk.price || 0) + (bk.mix || 0) + (bk.cost_total || 0)) - (bk.delta_gm_perkg || 0)) < 0.01,
        cogs_split: false, ingredients: [], ingredients_meta: null,
        note: 'Category-level bridge — SKU detail not comparable across Jan-2026 consolidation. COGS shown as a single Cost bar; prior window at 2025 (Vienovo_Old) feed scope 103+104. National aggregate only.'
      }
    } else if (include.has('bridge')) {
      const itemSql = `SELECT T1.ItemCode AS item, ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.LineTotal),0) AS revenue, ISNULL(SUM(T1.GrssProfit),0) AS gp
        ${baseFrom} ${scopeWhere} GROUP BY T1.ItemCode HAVING SUM(T1.InvQty) <> 0`

      // Phase 2: per-SKU COGS split (RM/Packaging/Feedtag) from production orders.
      // ratio = Σ(WOR1.IssuedQty × OITM.LastPurPrc) by class ÷ total, over YTD→anchor (stable, wide coverage).
      // Cost field = LastPurPrc (AvgPrice is 0 in Live). Feedtag = packaging items coded FT%.
      const yearStart = new Date(dateTo.getFullYear(), 0, 1)
      let ratioMap = {}, cogsSplit = false
      try {
        const rr = await query(`
          SELECT W.ItemCode AS sku,
            SUM(R.IssuedQty * ISNULL(I2.LastPurPrc,0)) AS tot,
            SUM(CASE WHEN I2.ItmsGrpCod=104 AND I2.ItemCode LIKE 'FT%' THEN R.IssuedQty*ISNULL(I2.LastPurPrc,0) ELSE 0 END) AS ft,
            SUM(CASE WHEN I2.ItmsGrpCod=104 AND I2.ItemCode NOT LIKE 'FT%' THEN R.IssuedQty*ISNULL(I2.LastPurPrc,0) ELSE 0 END) AS pkg
          FROM OWOR W INNER JOIN WOR1 R ON W.DocEntry=R.DocEntry INNER JOIN OITM I2 ON R.ItemCode=I2.ItemCode
          WHERE W.PostDate BETWEEN @ys AND @de AND R.IssuedQty > 0
          GROUP BY W.ItemCode HAVING SUM(R.IssuedQty * ISNULL(I2.LastPurPrc,0)) > 0`, { ys: yearStart, de: dateTo })
        rr.forEach(r => { const t = Number(r.tot) || 1; ratioMap[r.sku] = { pkg: Number(r.pkg) / t, ft: Number(r.ft) / t } })
        cogsSplit = rr.length > 0
      } catch (e) { console.warn('[margin-explorer] cost-ratio query failed:', e.message) }

      // Split each SKU's invoice COGS by its production ratio; RM = remainder (reconciles to cogs).
      const splitRows = arr => arr.map(r => {
        const rev = Number(r.revenue), gp = Number(r.gp), cogs = rev - gp
        const rat = ratioMap[r.item] || { pkg: 0, ft: 0 }
        const cp = cogs * rat.pkg, cf = cogs * rat.ft
        return { item: r.item, kg: Number(r.kg), revenue: rev, gp, cost_pkg: cp, cost_feedtag: cf, cost_rm: cogs - cp - cf }
      })
      const cur1 = splitRows(await query(itemSql, params))
      const prev0 = splitRows(await query(itemSql, { ...params, dateFrom: bFrom, dateTo: bTo }))

      // GM/ton bridge: per-unit decomposition × 1000. No volume effect (per-unit).
      const bk = bridge.bridgeGMperKg(prev0, cur1)
      const T = 1000

      // TRUE-price decomposition at customer×SKU granularity: the SKU bridge above
      // blends customers within a SKU, so a shift in WHICH customers bought leaks
      // into "Price". This pair-level pass makes the Price bar = real same-customer
      // same-SKU price move; composition splits into Customer Mix + Product Mix.
      let pairBk = null
      try {
        const pairSql = `SELECT T0.CardCode AS cust, T1.ItemCode AS sku,
            ISNULL(SUM(T1.InvQty),0) AS kg, ISNULL(SUM(T1.LineTotal),0) AS revenue, ISNULL(SUM(T1.GrssProfit),0) AS gp
          ${baseFrom} ${scopeWhere} GROUP BY T0.CardCode, T1.ItemCode HAVING SUM(T1.InvQty) <> 0`
        const [pairCur, pairPrev] = await Promise.all([
          query(pairSql, params),
          query(pairSql, { ...params, dateFrom: bFrom, dateTo: bTo })
        ])
        pairBk = bridge.bridgeGMperTonByPair(pairPrev, pairCur)
      } catch (e) { console.warn('[margin-explorer] pair bridge failed:', e.message) }

      // Ingredient contribution PER TON of feed (price + inclusion decomposition), cur vs prior.
      // For each raw-material ingredient: issued_kg, blended price (₱/kg), inclusion (kg/kg feed),
      // and ₱-per-ton-of-feed cost. Δ split into price effect vs inclusion (recipe) effect.
      let ingredients = []
      let ingredientsMeta = null
      try {
        // Per-ingredient issued kg + blended price, over FG (ItmsGrpCod=103) production orders,
        // ingredient in raw-material groups 101/102. LastPurPrc = cost (AvgPrice=0 in Live).
        // Issued RM per ITEM (group by code, not name — fixes duplicate-name collisions and
        // gives a clean key to join the period-actual purchase price). LastPurPrc carried only
        // as a price fallback for items not purchased in-window.
        const ingSql = (f, t) => query(`SELECT R.ItemCode AS code,
            MAX(LTRIM(RTRIM(I2.ItemName))) AS nm,
            SUM(R.IssuedQty) AS issued_kg,
            MAX(ISNULL(I2.LastPurPrc,0)) AS lastpur
          FROM OWOR W INNER JOIN WOR1 R ON W.DocEntry=R.DocEntry INNER JOIN OITM FI ON W.ItemCode=FI.ItemCode AND FI.ItmsGrpCod=103
          INNER JOIN OITM I2 ON R.ItemCode=I2.ItemCode
          WHERE W.PostDate BETWEEN @f AND @t AND I2.ItmsGrpCod IN (101,102) AND R.IssuedQty > 0
          GROUP BY R.ItemCode`, { f, t })

        // Period-ACTUAL purchase price per RM item (PCH1 window average ₱/kg). This is the
        // price signal that VARIES period-to-period — LastPurPrc is point-in-time and would
        // zero out every price effect. Mirrors the approved BOD-deck DS4 basket (actual PCH1
        // prices). RM purchase history exists only from Jan-2026; the bridge gate guarantees
        // the prior window is >= the migration cutoff, so both windows are in-range.
        const priceSql = (f, t) => query(`SELECT P1.ItemCode AS code,
            SUM(P1.LineTotal) AS spend, SUM(P1.Quantity) AS qty
          FROM OPCH P0 INNER JOIN PCH1 P1 ON P1.DocEntry=P0.DocEntry INNER JOIN OITM I3 ON P1.ItemCode=I3.ItemCode
          WHERE P0.CANCELED='N' AND I3.ItmsGrpCod IN (101,102) AND P0.DocDate BETWEEN @f AND @t AND P1.Quantity > 0
          GROUP BY P1.ItemCode`, { f, t })

        // Feed tons produced in each window. CmpltQty = FG completed qty (kg) on FG orders.
        // VALIDATE: if CmpltQty sums to 0/unsuitable, fall back to total issued kg as proxy.
        const feedSql = (f, t) => query(`SELECT ISNULL(SUM(W.CmpltQty),0) AS cmplt_kg,
            ISNULL(SUM(W.PlannedQty),0) AS planned_kg
          FROM OWOR W INNER JOIN OITM FI ON W.ItemCode=FI.ItemCode AND FI.ItmsGrpCod=103
          WHERE W.PostDate BETWEEN @f AND @t`, { f, t })

        const [curRows, priRows] = await Promise.all([ingSql(dateFrom, dateTo), ingSql(bFrom, bTo)])
        const [curFeed, priFeed] = await Promise.all([feedSql(dateFrom, dateTo), feedSql(bFrom, bTo)])
        const [curPx, priPx] = await Promise.all([priceSql(dateFrom, dateTo), priceSql(bFrom, bTo)])
        const pxMap = rows => { const m = {}; rows.forEach(r => { const q = Number(r.qty) || 0; if (q > 0) m[r.code] = Number(r.spend) / q }); return m }
        const curPxMap = pxMap(curPx), priPxMap = pxMap(priPx)

        // Resolve feed-ton basis per window with graceful fallback + label.
        const resolveFeed = (feedRow, ingRows) => {
          const cmplt = Number(feedRow[0] && feedRow[0].cmplt_kg) || 0
          const planned = Number(feedRow[0] && feedRow[0].planned_kg) || 0
          const issuedTotal = ingRows.reduce((a, r) => a + (Number(r.issued_kg) || 0), 0)
          if (cmplt > 0) return { kg: cmplt, basis: 'CmpltQty' }
          if (planned > 0) return { kg: planned, basis: 'PlannedQty (CmpltQty unavailable)' }
          return { kg: issuedTotal, basis: 'issued-kg proxy (no completed/planned qty)' }
        }
        const fCur = resolveFeed(curFeed, curRows)
        const fPri = resolveFeed(priFeed, priRows)
        const feedTonsCur = fCur.kg / 1000
        const feedTonsPri = fPri.kg / 1000

        if (feedTonsCur > 0) {
          // Build per-ITEM {price, priced, inclusion, name} for each window. Price = PCH1
          // window-average (period-actual); priced=false when the item wasn't purchased
          // in-window (then it carries LastPurPrc only as a level, never as a price MOVE).
          const idx = (rows, feedTons, pm) => {
            const o = {}
            rows.forEach(r => {
              const ik = Number(r.issued_kg) || 0
              const obs = pm[r.code]
              const priced = obs != null && obs > 0
              o[r.code] = { price: priced ? obs : (Number(r.lastpur) || 0), priced, inclusion: feedTons > 0 ? ik / (feedTons * 1000) : 0, nm: r.nm }
            })
            return o
          }
          const curIdx = idx(curRows, feedTonsCur, curPxMap)
          const priIdx = idx(priRows, feedTonsPri, priPxMap)

          const codes = new Set([...Object.keys(curIdx), ...Object.keys(priIdx)])
          let nBothPriced = 0
          const byName = {}   // sum effects across item codes that share a display name
          codes.forEach(code => {
            const c = curIdx[code] || { price: 0, priced: false, inclusion: 0, nm: priIdx[code] && priIdx[code].nm }
            const p = priIdx[code] || { price: 0, priced: false, inclusion: 0, nm: curIdx[code] && curIdx[code].nm }
            // Only attribute a PRICE move when a real purchase price exists in BOTH windows;
            // otherwise hold price flat (price_effect=0) so a static fallback never fakes inflation.
            const bothPriced = c.priced && p.priced
            if (bothPriced) nBothPriced++
            const cP = c.price
            const pP = bothPriced ? p.price : c.price
            const perton_cost = c.inclusion * cP * 1000               // ₱/ton of feed (current)
            const perton_cost_prior = p.inclusion * pP * 1000
            const price_effect = c.inclusion * (cP - pP) * 1000        // ₱/ton from price move (0 unless bothPriced)
            const inclusion_effect = (c.inclusion - p.inclusion) * pP * 1000 // ₱/ton from recipe move
            const nm = c.nm || p.nm || code
            const b = byName[nm] || (byName[nm] = { name: nm, perton_cost: 0, perton_cost_prior: 0, perton_delta: 0, price_effect: 0, inclusion_effect: 0, incl_now: 0, incl_prior: 0 })
            b.perton_cost += perton_cost
            b.perton_cost_prior += perton_cost_prior
            b.perton_delta += (perton_cost - perton_cost_prior)
            b.price_effect += price_effect
            b.inclusion_effect += inclusion_effect
            b.incl_now += c.inclusion
            b.incl_prior += p.inclusion
          })
          const built = Object.values(byName).map(b => {
            // Name-level blended ₱/kg = qty-weighted avg = cost/ton ÷ (inclusion × 1000).
            const priceNow = b.incl_now > 0 ? b.perton_cost / (b.incl_now * 1000) : 0
            const pricePrior = b.incl_prior > 0 ? b.perton_cost_prior / (b.incl_prior * 1000) : null
            return {
              name: b.name,
              price_now: Math.round(priceNow * 100) / 100,            // ₱/kg current
              price_prior: pricePrior == null ? null : Math.round(pricePrior * 100) / 100, // ₱/kg prior (null = new this period)
              incl_now_pct: Math.round(b.incl_now * 100 * 100) / 100, // % of feed mass (kg ingredient / kg feed)
              incl_prior_pct: b.incl_prior > 0 ? Math.round(b.incl_prior * 100 * 100) / 100 : null,
              perton_cost: Math.round(b.perton_cost * 10) / 10,
              perton_delta: Math.round(b.perton_delta * 10) / 10,
              price_effect: Math.round(b.price_effect * 10) / 10,
              inclusion_effect: Math.round(b.inclusion_effect * 10) / 10
            }
          })
          built.sort((a, b) => Math.abs(b.perton_delta) - Math.abs(a.perton_delta))
          ingredients = built.slice(0, 12)

          const sumDelta = built.reduce((a, r) => a + r.perton_delta, 0)
          const sumPrice = built.reduce((a, r) => a + r.price_effect, 0)
          const sumIncl = built.reduce((a, r) => a + r.inclusion_effect, 0)
          ingredientsMeta = {
            unit: 'php_per_ton_of_feed',
            feed_tons_current: Math.round(feedTonsCur),
            feed_tons_prior: Math.round(feedTonsPri),
            feed_basis: fCur.basis,
            price_source: 'PCH1 actual purchase price/kg (window avg); LastPurPrc level fallback',
            items_priced_both_windows: nBothPriced,
            sum_perton_delta: Math.round(sumDelta * 10) / 10,
            sum_price_effect: Math.round(sumPrice * 10) / 10,
            sum_inclusion_effect: Math.round(sumIncl * 10) / 10,
            note: `Recipe cost per ton of feed produced (basis: ${fCur.basis}). Price = actual purchase ₱/kg (PCH1) per window, split into price vs inclusion (recipe) effect. Indicative procurement lens — not reconciled to the sales-based GM/ton bridge.`
          }
        }
      } catch (e) { console.warn('[margin-explorer] ingredient per-ton query failed:', e.message); ingredients = [] }

      bridgeOut = {
        available: true, level: 'sku', basis: `${bridgeBasisLabel} · ₱/ton`, unit: 'php_per_ton',
        prior_gp: Math.round((bk.gm0_perkg || 0) * T), current_gp: Math.round((bk.gm1_perkg || 0) * T),
        price: Math.round((bk.price || 0) * T), mix: Math.round((bk.mix || 0) * T),
        cost: { total: Math.round((bk.cost_total || 0) * T), rm: Math.round((bk.cost_rm || 0) * T), packaging: Math.round((bk.cost_pkg || 0) * T), feedtag: Math.round((bk.cost_feedtag || 0) * T) },
        delta_gp: Math.round((bk.delta_gm_perkg || 0) * T),
        reconciles: Math.abs(((bk.price || 0) + (bk.mix || 0) + (bk.cost_total || 0)) - (bk.delta_gm_perkg || 0)) < 0.01,
        cogs_split: cogsSplit, ingredients, ingredients_meta: ingredientsMeta,
        note: cogsSplit
          ? 'GM/ton bridge: Price + Mix + COGS split RM/Packaging/Feedtag (production-order ratio, OITM.LastPurPrc). Per-unit ⇒ no volume.'
          : 'GM/ton bridge: COGS single bucket (no production ratio available for this slice).'
      }

      // True-price decomposition (customer×SKU): real same-customer same-SKU price
      // move vs Customer Mix vs Product Mix. The headline Price bar should be this
      // true_price, NOT the SKU-blended `price` above (which hides customer mix).
      // pairBk fields are ALREADY ₱/ton (the function works in tons) — do NOT ×T.
      // Fold the cross/entering-pair residual into Product Mix so the 4 bars
      // (True Price + Customer Mix + Product Mix + Cost) reconcile exactly to delta.
      if (pairBk && pairBk.available) {
        bridgeOut.true_price = Math.round(pairBk.true_price || 0)
        bridgeOut.true_cost = Math.round(pairBk.true_cost || 0)
        bridgeOut.customer_mix = Math.round(pairBk.customer_mix || 0)
        bridgeOut.product_mix = Math.round((pairBk.product_mix || 0) + (pairBk.interaction || 0))
        bridgeOut.true_basis = 'customer×SKU'
        bridgeOut.true_note = 'Price = real price move for the SAME customer buying the SAME SKU. Customer Mix = which customers bought (their different deal prices); Product Mix = which SKUs/new accounts invoiced. Composition is NOT a price change.'
      }
    }

    // ---- 12-month GM/ton trend (Live only; 2025 not comparable across consolidation) ----
    let trendOut = include.has('trend')
      ? { unit: 'gm_per_ton', ly_comparable: false, ly_suppressed_reason: 'pre_2026_not_comparable', series: [] }
      : null
    if (include.has('trend')) {
      try {
        // Trailing 12 months ending at the anchor month. Clamp the start to the
        // migration cutoff so the line stays inside clean Live data (2025 excluded).
        const trendTo = dateTo
        let trendFrom = new Date(trendTo.getFullYear(), trendTo.getMonth() - 11, 1)
        if (trendFrom < MIGRATION_CUTOFF) trendFrom = new Date(MIGRATION_CUTOFF)
        const trendParams = { ...params, dateFrom: trendFrom, dateTo: trendTo }
        // Same scope + role filter + region/bu/customer filters, but month-grouped.
        const trendWhere = applyRoleFilter(session, `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED='N'`)
        const trendRows = await query(`
          SELECT FORMAT(T0.DocDate,'yyyy-MM') AS ym,
            ISNULL(SUM(T1.GrssProfit),0) AS gp, ISNULL(SUM(T1.InvQty),0) AS kg
          ${baseFrom} ${trendWhere} AND I.ItmsGrpCod IN (103,105,102) ${f}
          GROUP BY FORMAT(T0.DocDate,'yyyy-MM')
          HAVING SUM(T1.InvQty) <> 0
          ORDER BY ym ASC`, trendParams)
        trendOut.series = trendRows.map(r => {
          const gp = Number(r.gp) || 0, kg = Number(r.kg) || 0
          return { month: r.ym, gm_per_ton: kg > 0 ? Math.round(gp / kg * 1000) : 0 }
        })
      } catch (e) { console.warn('[margin-explorer] trend query failed:', e.message) }
    }

    // ---- DISSECTION panels: finished-feed (Live 103 / Old 103+104), cross-DB, SSG spine ----
    // Faithful port of the Margin Dissection Analyser (see margin_cube.js + METHODOLOGY.md).
    let dissection = null
    if (include.has('dissection')) {
      try {
        const C = await cube.buildCube({ query, queryH }, { region, bu, customer, ssg: null })
        if (C.months.length) {
          const fromM = dateFrom.toISOString().slice(0, 7), toM = dateTo.toISOString().slice(0, 7)
          const nowYM = new Date().toISOString().slice(0, 7)   // current (partial) calendar month
          let inRange = C.months.filter(m => m >= fromM && m <= toM)
          if (!inRange.length) inRange = C.months.slice()
          // Bridge/mix/ingredient anchors must be COMPLETE months — exclude the running
          // partial month so we don't compare a full month against a few days. Trajectory
          // keeps every month (the last point is flagged partial for the chart).
          let anchorMonths = inRange.filter(m => m !== nowYM)
          if (!anchorMonths.length) anchorMonths = inRange.slice()
          let baseMonth = anchorMonths[0], cmpMonth = anchorMonths[anchorMonths.length - 1]
          if (baseMonth === cmpMonth) { const i = C.months.indexOf(cmpMonth); if (i > 0) baseMonth = C.months[i - 1] }  // single-month → MoM
          const traj = cube.trajectory(C.rows, C.months)
          if (traj.length && traj[traj.length - 1].month === nowYM) traj[traj.length - 1].partial = true
          const cmpPartial = cmpMonth === nowYM

          // ---- price_drill: decompose the bridge's Price bar into TRUE price moves
          // (same customer + same SKU) vs customer-mix vs SKU-mix composition.
          // Live (2026) anchors only — 2025 (Old DB) customer/SKU codes were fully
          // re-coded at the Jan-2026 consolidation, so a cross-DB drill is meaningless.
          let priceDrillOut
          // The ONE canonical bridge (Bennet, exact): Price + Cost + Customer/BU Mix +
          // Product Mix, customer×SKU, feed 103, reconciles to the GM/ton delta.
          let canonicalBridge = { available: false, reason: 'pre-2026 anchor — customer/SKU codes not comparable across the Jan-2026 consolidation' }
          if (baseMonth < '2026-01' || cmpMonth < '2026-01') {
            priceDrillOut = { available: false, reason: 'pre-2026 anchor' }
          } else {
            try {
              const mb = (ym) => { const [y, m] = ym.split('-').map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 1)] }
              const [b0, b1] = mb(baseMonth), [c0, c1] = mb(cmpMonth)
              const dp = { b0, b1, c0, c1 }
              // same region/bu/customer predicates the cube applies (Live branch)
              let dw = ''
              if (region !== 'ALL') {
                if (region === 'Other') dw += ` AND T1.OcrCode2 NOT LIKE 'L-%' AND T1.OcrCode2 NOT LIKE 'V-%' AND T1.OcrCode2 NOT LIKE 'M-%'`
                else { dw += ` AND T1.OcrCode2 LIKE @rpref`; dp.rpref = REGION_PREFIX[region] }
              }
              if (bu !== 'ALL') { dw += ` AND G.GroupName=@bu`; dp.bu = bu }
              if (customer) { dw += ` AND (T0.CardCode=@cust OR T0.CardName LIKE @custl)`; dp.cust = customer; dp.custl = '%' + customer + '%' }
              const DRILL_SQL = `
                SELECT ym, ssg, sku, name, cust, SUM(rev) rev, SUM(kg) kg, SUM(gp) gp FROM (
                  SELECT FORMAT(T0.DocDate,'yyyy-MM') ym, ISNULL(S.Name,'UNSPEC') ssg,
                    T1.ItemCode sku, T2.ItemName name, T0.CardCode cust,
                    T1.LineTotal rev, T1.InvQty kg, T1.GrssProfit gp
                  FROM OINV T0 JOIN INV1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
                  LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
                  LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
                  WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod=103
                    AND ((T0.DocDate>=@b0 AND T0.DocDate<@b1) OR (T0.DocDate>=@c0 AND T0.DocDate<@c1)) ${dw}
                  UNION ALL
                  SELECT FORMAT(T0.DocDate,'yyyy-MM') ym, ISNULL(S.Name,'UNSPEC') ssg,
                    T1.ItemCode sku, T2.ItemName name, T0.CardCode cust,
                    -T1.LineTotal rev, -T1.InvQty kg, -T1.GrssProfit gp
                  FROM ORIN T0 JOIN RIN1 T1 ON T1.DocEntry=T0.DocEntry JOIN OITM T2 ON T2.ItemCode=T1.ItemCode
                  LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
                  LEFT JOIN [@OITMSSG] S ON S.Code=T2.U_SSG
                  WHERE T0.CANCELED='N' AND T1.InvQty>0 AND T2.ItmsGrpCod=103
                    AND ((T0.DocDate>=@b0 AND T0.DocDate<@b1) OR (T0.DocDate>=@c0 AND T0.DocDate<@c1)) ${dw}
                ) X GROUP BY ym, ssg, sku, name, cust`
              const drillRaw = await query(DRILL_SQL, dp)
              const toRow = r => ({ ssg: r.ssg || 'UNSPEC', sku: r.sku, name: r.name, cust: r.cust, rev: Number(r.rev) || 0, revenue: Number(r.rev) || 0, kg: Number(r.kg) || 0, gp: Number(r.gp) || 0 })
              const baseRows = drillRaw.filter(r => r.ym === baseMonth).map(toRow)
              const cmpRows = drillRaw.filter(r => r.ym === cmpMonth).map(toRow)
              const pd = cube.priceDrill(baseRows, cmpRows)

              // THE canonical bridge — same customer×SKU rows, Bennet exact decomposition.
              const cbk = bridge.bridgeCanonicalGMperTon(baseRows, cmpRows)
              if (cbk.available) {
                canonicalBridge = {
                  available: true, unit: 'php_per_ton', scope: 'finished_feed_103',
                  method: 'Bennet indicator · customer×SKU · exact',
                  base_month: baseMonth, compare_month: cmpMonth, compare_partial: cmpPartial,
                  prior_gm_ton: Math.round(cbk.gm0_per_ton), current_gm_ton: Math.round(cbk.gm1_per_ton),
                  delta: Math.round(cbk.delta),
                  price: Math.round(cbk.price), cost: Math.round(cbk.cost),
                  customer_mix: Math.round(cbk.customer_mix), product_mix: Math.round(cbk.product_mix),
                  reconciles: Math.abs((cbk.price + cbk.cost + cbk.customer_mix + cbk.product_mix) - cbk.delta) < 1,
                  note: 'GM/ton bridge · finished feed (103) · ' + baseMonth + ' → ' + cmpMonth + (cmpPartial ? ' (compare month partial)' : '') + '. Price & Cost = SAME customer + SAME SKU; Customer/BU Mix & Product Mix = composition (who/what sold), not price action. Bennet decomposition — reconciles exactly.'
                }
              } else {
                canonicalBridge = { available: false, reason: cbk.reason || 'no feed rows in anchor months' }
              }
              priceDrillOut = pd.available === false ? pd : {
                available: true, unit: 'php_per_ton',
                total: Math.round(pd.total),
                true_price: Math.round(pd.true_price),
                customer_mix: Math.round(pd.customer_mix),
                sku_mix: Math.round(pd.sku_mix),
                residual: Math.round(pd.residual),
                price_held_pct: pd.price_held_pct == null ? null : Math.round(pd.price_held_pct * 10) / 10,
                top_rows: pd.top_rows.map(r => ({
                  ssg: r.ssg, sku: r.sku, name: r.name,
                  tons_b: Math.round(r.tons_b), tons_c: Math.round(r.tons_c),
                  rev_ton_b: Math.round(r.rev_ton_b), rev_ton_c: Math.round(r.rev_ton_c),
                  true_price: Math.round(r.true_price), customer_mix: Math.round(r.customer_mix),
                  held_pct: r.held_pct == null ? null : Math.round(r.held_pct)
                })),
                note: 'Price bar split at base-month weights: true price = same customer + same SKU; customer mix & SKU mix = composition shifts, not price action. price_held = compare-month kg (both-month cust×SKU pairs) within ±0.5% of base price.'
              }
            } catch (e) {
              console.warn('[margin-explorer] price drill failed:', e.message)
              priceDrillOut = { available: false, reason: e.message }
            }
          }

          dissection = {
            available: true, scope: 'finished_feed', basis: 'Live 103 / Old 103+104 · ₱/ton',
            base_month: baseMonth, compare_month: cmpMonth, compare_partial: cmpPartial,
            compare_days: cmpPartial ? new Date().getDate() - 1 : null, months: C.months,
            trajectory: traj,
            bridge: cube.ssgBridge(C.rows, baseMonth, cmpMonth),
            mix_bridge: cube.mixBridge(C.rows, baseMonth, cmpMonth),
            ingredients: cube.ingredientContribution(C.rows, C.intensity, C.basket, baseMonth, cmpMonth),
            price_drill: priceDrillOut,
            canonical_bridge: canonicalBridge,
            category_trend: cube.categoryTrend(C.rows, C.months)
          }
        } else {
          dissection = { available: false, reason: 'No finished-feed rows for this selection.' }
        }
      } catch (e) { console.warn('[margin-explorer] dissection failed:', e.message); dissection = { available: false, reason: e.message } }
    }

    const result = {
      meta: {
        endpoint: 'margin-explorer', sap_validated: true, data_source: 'sap_b1',
        window: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
        applied_filters: { period, ref_month: refMonthKey, region, bu, customer, group_by: groupBy, compare, include: [...include] },
        data_quality: { volume_basis: 'INV1.InvQty (kg)', region_basis: 'OcrCode2 (sales dim-2)', bu_basis: 'OCRD.GroupCode->OCRG (real)', notes: ['Pre-rebate gross profit.', 'vs-LY at customer/SKU not comparable across Jan-2026 consolidation; bridge falls back to category (SSG) level when the comparison crosses the cutoff (national only).'] }
      },
      hero,
      matrix: { group_by: groupBy, rows: matrixRows, total_gp: Math.round(totGp) },
      bridge: bridgeOut,
      trend: trendOut,
      dissection,
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
