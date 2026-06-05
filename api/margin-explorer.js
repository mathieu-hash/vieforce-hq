// GET /api/margin/explorer — Margin Explorer (dynamic GM analysis cockpit)
//
// SKELETON ONLY. SAP (analytics.vienovo.ph:4444) is intermittently unreachable;
// the SQL below is DRAFT and every assumption is marked /* VALIDATE-VS-SAP */.
// Until validated, live-data paths return clearly-labeled mock/empty with
// meta.sap_validated = false. Route is NOT registered yet (see server.js separately).
//
// Full SQL set + validation checklist: docs/superpowers/specs/margin-explorer-SQL.md
// Design spec: docs/superpowers/specs/2026-06-05-margin-explorer-design.md (§6 = response shape).

const { query, queryDateRange } = require('./_db')
const { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')
const {
  normalizeRegion, normalizeSegment,
  regionFilterSql, segmentFilterSql, filterMeta
} = require('./lib/business_filters')

// margin_bridge is built by a parallel agent. Require defensively so the skeleton
// loads even before that module lands; null-guard at the call site.
let marginBridge = null
try { marginBridge = require('./lib/margin_bridge') } catch (_) { marginBridge = null }

// Whitelist: group_by key -> fixed SQL fragments (SELECT expr, GROUP BY expr, alias join needs).
// User input never reaches SQL as a string — only the key selects a pre-written fragment.
// All UDF aliases / group codes below are ASSUMED — see VALIDATE-VS-SAP checklist.
const GROUP_BY = {
  region:      { select: 'INV1.OcrCode2',          group: 'INV1.OcrCode2',          needs: [] },           /* VALIDATE-VS-SAP */
  bu:          { select: 'G.GroupName',             group: 'G.GroupName',             needs: ['cardGroup'] },/* VALIDATE-VS-SAP */
  dsm:         { select: 'S.SlpName',               group: 'S.SlpName',               needs: ['slp'] },      /* VALIDATE-VS-SAP */
  brand:       { select: 'I.U_brands',              group: 'I.U_brands',              needs: [] },           /* VALIDATE-VS-SAP */
  species:     { select: 'I.U_SPECIE',              group: 'I.U_SPECIE',              needs: [] },           /* VALIDATE-VS-SAP */
  sales_group: { select: 'I.U_SALES_GROUP',         group: 'I.U_SALES_GROUP',         needs: [] },           /* VALIDATE-VS-SAP */
  ssg:         { select: 'I.U_SSG',                 group: 'I.U_SSG',                 needs: [] },           /* VALIDATE-VS-SAP */
  customer:    { select: 'T0.CardName',             group: 'T0.CardCode, T0.CardName', needs: [] },
  sku:         { select: 'T1.Dscription',           group: 'T1.ItemCode, T1.Dscription', needs: [] }
}
const DEFAULT_GROUP_BY = 'sales_group'

function normalizeGroupBy(g) {
  const k = String(g || '').trim().toLowerCase()
  return GROUP_BY[k] ? k : DEFAULT_GROUP_BY
}
function normalizeCompare(c) {
  const v = String(c || 'pp').trim().toLowerCase()
  return (v === 'ly' || v === 'pp') ? v : 'pp'
}
function normalizeUnit(u) {
  const v = String(u || 'gm_ton').trim().toLowerCase()
  return ['kg', 'ton', 'gp_pct', 'gp_php', 'rev_kg', 'gm_ton'].includes(v) ? v : 'gm_ton'
}
function parseInclude(inc) {
  const all = ['bridge', 'trend', 'movers', 'gap']
  if (!inc) return new Set(all)
  const want = String(inc).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const ok = want.filter(w => all.includes(w))
  return new Set(ok.length ? ok : all)
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth — Supabase session OR internal service token (role filter must include
  // exec/director/marketing; all handled in applyRoleFilter / verifyServiceToken).
  const session = (await verifySession(req)) || (await verifyServiceToken(req))
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // --- Param parse ---
  const period = String(req.query.period || 'YTD').toUpperCase()
  const refMonthKey = (typeof req.query.ref_month === 'string' && /^\d{4}-\d{2}$/.test(req.query.ref_month.trim()))
    ? req.query.ref_month.trim()
    : 'live'
  const region   = normalizeRegion(req.query.region)
  const segment  = normalizeSegment(req.query.segment)
  const bu       = (typeof req.query.bu === 'string' && req.query.bu.trim()) ? req.query.bu.trim() : 'ALL'
  const groupBy  = normalizeGroupBy(req.query.group_by)
  const drillRaw = (typeof req.query.drill_path === 'string') ? req.query.drill_path.trim() : ''
  const drillPath = drillRaw ? drillRaw.split(',').map(s => s.trim()).filter(Boolean) : []
  const compare  = normalizeCompare(req.query.compare)
  const unit     = normalizeUnit(req.query.unit)
  const include  = parseInclude(req.query.include)

  // Cache key includes ALL params (incl. group_by + bu + drill) + user scope.
  const cacheKey = [
    'margin_explorer_v1', session.id, session.role, session.region || 'ALL',
    refMonthKey, period, region, segment, bu, groupBy,
    drillPath.join('>') || 'none', compare, unit,
    [...include].sort().join('+')
  ].join('_')
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const periodOpts = refMonthKey !== 'live' ? { refMonth: refMonthKey } : {}
    const { dateFrom, dateTo } = getPeriodDates(period, periodOpts)

    // Composable WHERE fragments (region/segment via shared helpers; drill/bu drafted).
    const lineFilters = regionFilterSql(region, 'T1') + segmentFilterSql(segment, 'T0')
    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere) + lineFilters
    void filteredWhere // wired into DRAFT SQL below once SAP is reachable

    const dim = GROUP_BY[groupBy]

    // =========================================================================
    // DRAFT SQL — slice aggregation by chosen group_by (matrix rows + hero totals)
    // Full version + checklist: docs/superpowers/specs/margin-explorer-SQL.md §2
    // NOT executed while sap_validated = false.
    // =========================================================================
    const SLICE_SQL = `
      /* VALIDATE-VS-SAP: ItmsGrpCod scope (103/105/102), UDF aliases, OcrCode2, OCRG join */
      SELECT
        ${dim.select}                                                AS dim,
        ISNULL(SUM(T1.LineTotal), 0)                                  AS sales,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0) AS vol,
        ISNULL(SUM(T1.GrssProfit), 0)                                 AS gp,
        CASE WHEN SUM(T1.LineTotal) > 0
          THEN SUM(T1.GrssProfit) / SUM(T1.LineTotal) * 100
          ELSE 0 END                                                   AS gp_pct,
        CASE WHEN SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) > 0
          THEN SUM(T1.GrssProfit) / (SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0)
          ELSE 0 END                                                   AS gm_ton
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry                  -- DocEntry, never DocNum
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      LEFT JOIN OCRD C ON T0.CardCode = C.CardCode                     /* VALIDATE-VS-SAP: bu only */
      LEFT JOIN OCRG G ON C.GroupCode = G.GroupCode                    /* VALIDATE-VS-SAP */
      LEFT JOIN OSLP S ON T0.SlpCode = S.SlpCode
      ${filteredWhere}
        AND I.ItmsGrpCod IN (103, 105, 102)                           /* VALIDATE-VS-SAP: external-sellable */
      GROUP BY ${dim.group}                                           /* VALIDATE-VS-SAP */
      HAVING SUM(T1.LineTotal) > 0
      ORDER BY gp DESC
    `
    void SLICE_SQL

    // =========================================================================
    // DRAFT SQL — per-item rows for the selected slice (feeds lib/margin_bridge).
    // Two windows: current (1) + comparison (0, pp|ly). Full version: SQL.md §3.
    // =========================================================================
    const PER_ITEM_SQL = `
      /* VALIDATE-VS-SAP: per-item P/C/M/Q for one slice + one period window */
      SELECT
        T1.ItemCode                                                   AS sku,
        T1.Dscription                                                 AS sku_name,
        SUM(T1.Quantity * ISNULL(I.NumInSale, 1))                     AS qty_kg,
        SUM(T1.LineTotal)                                             AS revenue,
        SUM(T1.GrssProfit)                                            AS gp,
        (SUM(T1.LineTotal) - SUM(T1.GrssProfit))                      AS cogs
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
        AND I.ItmsGrpCod IN (103, 105, 102)                           /* VALIDATE-VS-SAP */
      GROUP BY T1.ItemCode, T1.Dscription
      HAVING SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) <> 0
    `
    void PER_ITEM_SQL

    // -------------------------------------------------------------------------
    // SAP is gated OFF until the SQL above is validated live. Until then every
    // live-data field is labeled mock/empty and meta.sap_validated = false.
    // When SAP returns: run SLICE_SQL via queryDateRange(...), map to matrix rows,
    // run PER_ITEM_SQL for both windows, feed marginBridge.decompose(...), and
    // flip sap_validated true once §VALIDATE checklist is cleared.
    // -------------------------------------------------------------------------
    const SAP_VALIDATED = false

    // Bridge stub — call the real module if present, else empty labeled shape.
    const bridge = (include.has('bridge'))
      ? (marginBridge && typeof marginBridge.decompose === 'function'
          ? { ...marginBridge.emptyResult?.() , available: false, reason: 'sap_offline' }
          : { available: false, reason: marginBridge ? 'sap_offline' : 'margin_bridge_module_pending',
              volume: 0, mix: 0, price: 0, cost: { total: 0, rm: 0, packaging: 0, feedtag: 0 }, delta_gp: 0 })
      : null

    const result = {
      meta: {
        endpoint: 'margin/explorer',
        sap_validated: SAP_VALIDATED,                 // <-- false until live SQL confirmed
        data_source: SAP_VALIDATED ? 'sap_b1' : 'mock_empty',
        applied_filters: {
          period,
          ref_month: refMonthKey,
          ...filterMeta(region, segment),
          bu,
          group_by: groupBy,
          drill_path: drillPath,
          compare,
          unit,
          include: [...include]
        },
        data_quality: {
          notes: [
            'SKELETON: SAP intermittently unreachable; all live values are mock/empty.',
            'SQL drafts marked VALIDATE-VS-SAP in docs/superpowers/specs/margin-explorer-SQL.md.',
            marginBridge ? 'margin_bridge module loaded.' : 'margin_bridge module pending (parallel build).',
            'LY series suppressed at customer/SKU/region across the Jan-2026 consolidation boundary.'
          ]
        }
      },

      // §6 — hero KPIs (4): Net Sales · GP ₱ · GP% · GM/ton, each with vs-PP/LY delta.
      hero: {
        net_sales: { value: 0, delta: null, delta_basis: compare },
        gross_profit: { value: 0, delta: null, delta_basis: compare },
        gp_pct: { value: 0, delta: null, delta_basis: compare },
        gm_ton: { value: 0, delta: null, delta_basis: compare }
      },

      // §6 — drill matrix: rows for current group/drill level (empty until SAP).
      matrix: {
        group_by: groupBy,
        drill_path: drillPath,
        unit,
        rows: []   // { dim, sales, vol, gp, gp_pct, gm_ton, pct_of_gp, delta, expandable }
      },

      // §6 — context trio for the selected slice.
      bridge,                                                    // null if not in include
      trend: include.has('trend')
        ? { unit: 'gm_ton', ly_comparable: false, ly_suppressed_reason: 'pending_sap', series: [], ly_series: null }
        : null,                                                  // 12-mo GM/ton stub
      movers: include.has('movers')
        ? { basis: 'mix_contribution', items: [] }
        : null,                                                  // top margin movers stub

      // §6 — gap-analysis mode (slice rate vs reference, same driver language).
      gap: include.has('gap')
        ? { available: false, reference: null, decomposition: null }
        : null
    }

    cache.set(cacheKey, result, 120)   // short TTL per spec §6
    res.json(result)
  } catch (err) {
    console.error('API error [margin-explorer]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
