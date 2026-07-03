// /api/team — EVP Sales & Marketing Dashboard endpoint.
//
// REWRITE 2026-04-19 (Joel demo prep). Old endpoint summed per-RSM personal
// SlpCode totals to derive EVP YTD volume — 12,509 MT vs reality 56,522 MT
// (4.5× under-count). Root cause: each "RSM" was matched fuzzily to ONE
// OINV.SlpCode row representing only the RSM's *personal* directly-attributed
// sales, not the rollup of all DSMs/TSRs reporting to them.
//
// New approach (matches SAP audit 2026-04-19):
//   • National totals via independent OINV+ODLN aggregate (no rep filter)
//   • Per-RSM rollup via OSLP.U_rsm self-reference — each RSM's territory =
//     all reps with U_rsm = that RSM's SlpCode (includes themselves)
//   • RSM list discovered from OSLP, not hardcoded
//   • LY comparison via historical DB; rep-name join (codes can re-key too)
//   • Speed = YTD_ODLN / shipping_days_elapsed (Mon-Sat workdays since Jan 1)
//   • Active accounts = COUNT(DISTINCT CardCode) YTD, no exclusions
//
// CRITICAL: no customer-code exclusion. CCPC and similar are real customers.

const { query, queryH, queryBoth } = require('./_db')
const { serverError } = require('./lib/http')
const { verifySession, verifyServiceToken, getPeriodDates } = require('./_auth')
const cache = require('../lib/cache')
const { getProratedYtdBudgetMt } = require('./lib/budget_2026')
const { countShippingDays } = require('./lib/shipping_days')
const { normalizeRegion, normalizeSegment, regionFilterSql, segmentFilterSql, filterMeta } = require('./lib/business_filters')

// FY2026 monthly volume budget (mirrors api/dashboard.js + api/budget.js).
// Single source of truth would ideally be a shared module — duplicated here
// to keep the rewrite self-contained for the demo.

// Director SlpCode (Joel Durano). Excluded from RSM list — he IS the EVP.
const DIRECTOR_SLPCODE = 3

// Shipping-day count now comes from lib/shipping_days (Mon-Sat MINUS PH holidays)
// so team speed matches the Speed page (speed.js/budget.js use the same source).

function ytdBudgetMt(today) {
  return getProratedYtdBudgetMt(today)
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const refMonthKey = (typeof req.query.ref_month === 'string' && /^\d{4}-\d{2}$/.test(req.query.ref_month.trim()))
    ? req.query.ref_month.trim()
    : 'live'
  const period = String(req.query.period || 'YTD').toUpperCase()
  const periodOpts = refMonthKey !== 'live' ? { refMonth: refMonthKey } : {}
  const region = normalizeRegion(req.query.region)
  const segment = normalizeSegment(req.query.segment)

  const cacheKey = `team_v3_${refMonthKey}_${period}_${region}_${segment}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const { dateFrom, dateTo } = getPeriodDates(period, periodOpts)
    const today = new Date(dateTo.getFullYear(), dateTo.getMonth(), dateTo.getDate())

    const lyStart = new Date(dateFrom)
    lyStart.setFullYear(lyStart.getFullYear() - 1)
    const lyEnd = new Date(dateTo)
    lyEnd.setFullYear(lyEnd.getFullYear() - 1)

    // Prior period — same length as [dateFrom, dateTo], ending day before period start
    // (mirrors api/dashboard.js + api/sales.js window math).
    const ppTo = new Date(dateFrom)
    ppTo.setDate(ppTo.getDate() - 1)
    const ppFrom = new Date(dateFrom)
    ppFrom.setTime(ppFrom.getTime() - (dateTo.getTime() - dateFrom.getTime()))

    const mtdBounds = getPeriodDates('MTD', periodOpts)
    const monthStart = mtdBounds.dateFrom
    const monthEnd = mtdBounds.dateTo
    const lineFilters = regionFilterSql(region, 'T1') + segmentFilterSql(segment, 'T0')

    // ───────────────────────────────────────────────────────────────────────
    // 1. NATIONAL TOTALS — single query, no rep filter, no customer exclusions
    // ───────────────────────────────────────────────────────────────────────
    const nationalOinv = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol_invoiced,
        ISNULL(SUM(T1.LineTotal), 0)                                   AS ytd_revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                  AS ytd_gm,
        COUNT(DISTINCT T0.CardCode)                                    AS active_customers,
        COUNT(DISTINCT T0.SlpCode)                                     AS active_reps
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters}
    `, { dateFrom, dateTo, region })

    const nationalOdln = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters}
    `, { dateFrom, dateTo, region })

    // YTD-LY (entire prior year through same M-D) — historical DB.
    // Pull both OINV (revenue/GM) and ODLN (volume of record) so vs-LY
    // matches Home page convention (ODLN-vs-ODLN, not ODLN-vs-OINV).
    const nationalLy = await queryH(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol_invoiced,
        ISNULL(SUM(T1.LineTotal), 0)                                   AS ytd_revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                  AS ytd_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'${lineFilters}
    `, { lyStart, lyEnd, region }).catch(e => {
      console.warn('[team] LY national OINV failed:', e.message); return [{}]
    })

    const nationalLyOdln = await queryH(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'${lineFilters}
    `, { lyStart, lyEnd, region }).catch(e => {
      console.warn('[team] LY national ODLN failed:', e.message); return [{}]
    })

    const nationalPpOdln = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS pp_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @ppFrom AND @ppTo AND T0.CANCELED = 'N'${lineFilters}
    `, { ppFrom, ppTo, region })

    // ───────────────────────────────────────────────────────────────────────
    // 2. RSM ROSTER — discover RSMs from OSLP.U_rsm self-references
    // ───────────────────────────────────────────────────────────────────────
    const rsmRows = await query(`
      SELECT R.SlpCode AS rsm_code, R.SlpName AS rsm_name,
        -- dominant sales region of the RSM's territory (OcrCode2 L-/V-/M-), for hero region-match.
        -- OSLP.Memo holds the rep name (not a region), so derive region from actual shipments.
        (SELECT TOP 1 CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END
         FROM OINV T0 INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
         WHERE T0.SlpCode IN (SELECT S2.SlpCode FROM OSLP S2 WHERE S2.U_rsm = R.SlpCode) AND T0.CANCELED = 'N'
         GROUP BY CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END
         ORDER BY SUM(T1.InvQty) DESC) AS dom_region
      FROM OSLP R
      WHERE R.Active = 'Y'
        AND R.SlpCode = R.U_rsm   -- self-pointer = is_an_RSM
        AND R.SlpCode <> @director
        AND R.SlpCode > 0
      ORDER BY R.SlpName
    `, { director: DIRECTOR_SLPCODE })

    // ───────────────────────────────────────────────────────────────────────
    // 3. PER-RSM ROLLUP — sum every report's (S.U_rsm = R.SlpCode) sales
    // ───────────────────────────────────────────────────────────────────────
    const rsmYtd = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                    AS ytd_revenue,
        ISNULL(SUM(T1.GrssProfit), 0)                                   AS ytd_gm,
        COUNT(DISTINCT T0.CardCode)                                     AS active_customers,
        COUNT(DISTINCT S.SlpCode)                                       AS reports_count
      FROM OSLP S
      INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters}
      GROUP BY S.U_rsm
    `, { dateFrom, dateTo, region })
    const rsmYtdMap = Object.fromEntries(rsmYtd.map(r => [r.rsm_code, r]))

    const rsmPp = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS pp_vol
      FROM OSLP S
      INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate BETWEEN @ppFrom AND @ppTo AND T0.CANCELED = 'N'${lineFilters}
      GROUP BY S.U_rsm
    `, { ppFrom, ppTo, region })
    const rsmPpMap = Object.fromEntries(rsmPp.map(r => [r.rsm_code, r.pp_vol]))

    // MTD ODLN per RSM (calendar month of anchor)
    const rsmMtdOdln = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS mtd_vol_odln
      FROM OSLP S
      INNER JOIN ODLN T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate BETWEEN @monthStart AND @monthEnd AND T0.CANCELED = 'N'${lineFilters}
      GROUP BY S.U_rsm
    `, { monthStart, monthEnd, region })
    const rsmMtdMap = Object.fromEntries(rsmMtdOdln.map(r => [r.rsm_code, r.mtd_vol_odln]))

    // Period ODLN per RSM (speed denominator)
    const rsmYtdOdln = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol_odln
      FROM OSLP S
      INNER JOIN ODLN T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters}
      GROUP BY S.U_rsm
    `, { dateFrom, dateTo, region })
    const rsmYtdOdlnMap = Object.fromEntries(rsmYtdOdln.map(r => [r.rsm_code, r.ytd_vol_odln]))

    // LY rollup per RSM — historical DB, JOIN on SlpName because SlpCodes can
    // diverge across migration. We resolve current rep's name → look up that
    // name in OSLP_old → roll its U_rsm in old space → map back via name match.
    // Pragmatic shortcut: pull historical rep totals keyed by their CURRENT
    // RSM (using OSLP from current DB to find U_rsm), then group by rsm_code
    // in JS. This works because rep PEOPLE are stable even when codes aren't.
    const rsmLyRaw = await queryH(`
      SELECT
        S.SlpName                                                        AS slp_name,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ly_vol
      FROM OSLP S
      INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'${lineFilters}
      GROUP BY S.SlpName
    `, { lyStart, lyEnd, region }).catch(e => {
      console.warn('[team] LY per-rep failed:', e.message); return []
    })

    // Need to map historical rep names → their current U_rsm.
    // Pull (SlpName → U_rsm) from current OSLP.
    const repToRsm = await query(`
      SELECT S.SlpName, S.U_rsm
      FROM OSLP S
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
    `)
    const nameToRsm = {}
    for (const r of repToRsm) {
      const k = (r.SlpName || '').toUpperCase().trim()
      if (k) nameToRsm[k] = r.U_rsm
    }
    const rsmLyMap = {}
    for (const r of rsmLyRaw) {
      const k = (r.slp_name || '').toUpperCase().trim()
      const rsmCode = nameToRsm[k]
      if (rsmCode == null) continue   // historical rep not in current org
      rsmLyMap[rsmCode] = (rsmLyMap[rsmCode] || 0) + Number(r.ly_vol || 0)
    }

    // ───────────────────────────────────────────────────────────────────────
    // 4. MONTHLY GRID per RSM (last 6 months) — for Performance Matrix
    // ───────────────────────────────────────────────────────────────────────
    const monthlyRsmRaw = await queryBoth(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        FORMAT(T0.DocDate, 'yyyy-MM')                                    AS month,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS vol
      FROM OSLP S
      INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.U_rsm IS NOT NULL
        AND T0.DocDate >= DATEADD(MONTH, -6, @anchor) AND T0.CANCELED = 'N'${lineFilters}
        AND T0.DocDate <= @anchor
      GROUP BY S.U_rsm, FORMAT(T0.DocDate, 'yyyy-MM')
    `, { anchor: today, region }).catch(e => { console.warn('[team] monthly grid failed:', e.message); return [] })
    // Note: queryBoth concatenates current + historical rows. Historical rep's
    // U_rsm is from OLD OSLP — could be different from current. Best-effort:
    // sum by (rsm_code, month). Where the same rep moved across RSMs at
    // migration, pre-2026 volume gets attributed to OLD RSM. Document.
    const monthlyMap = {}
    for (const r of monthlyRsmRaw) {
      const k = `${r.rsm_code}|${r.month}`
      monthlyMap[k] = (monthlyMap[k] || 0) + Number(r.vol || 0)
    }

    // ───────────────────────────────────────────────────────────────────────
    // 5. DSO + SILENT + NEG-MARGIN per RSM
    // ───────────────────────────────────────────────────────────────────────
    const rsmDso = await query(`
      SELECT
        S.U_rsm AS rsm_code,
        CASE WHEN SUM(T0.DocTotal) > 0
          THEN SUM(CASE WHEN T0.DocTotal > T0.PaidToDate
                        THEN T0.DocTotal - T0.PaidToDate ELSE 0 END)
               / (SUM(T0.DocTotal) / 365.0)
          ELSE 0 END AS dso
      FROM OSLP S
      INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
      WHERE S.Active='Y' AND S.U_rsm IS NOT NULL
        AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,@anchor) AND T0.DocDate <= @anchor
      GROUP BY S.U_rsm
    `, { anchor: today }).catch(() => [])
    const rsmDsoMap = Object.fromEntries(rsmDso.map(r => [r.rsm_code, r.dso]))

    const rsmSilent = await query(`
      SELECT rsm_code, COUNT(*) AS silent_count
      FROM (
        SELECT S.U_rsm AS rsm_code, T0.CardCode
        FROM OSLP S
        INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
        WHERE S.Active='Y' AND S.U_rsm IS NOT NULL
          AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,@anchor) AND T0.DocDate <= @anchor
        GROUP BY S.U_rsm, T0.CardCode
        HAVING DATEDIFF(DAY, MAX(T0.DocDate), @anchor) >= 30
      ) sub
      GROUP BY rsm_code
    `, { anchor: today }).catch(() => [])
    const rsmSilentMap = Object.fromEntries(rsmSilent.map(r => [r.rsm_code, r.silent_count]))

    const rsmNeg = await query(`
      SELECT rsm_code, COUNT(*) AS neg_margin_count
      FROM (
        SELECT S.U_rsm AS rsm_code, T0.CardCode
        FROM OSLP S
        INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
        INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
        WHERE S.Active='Y' AND S.U_rsm IS NOT NULL
          AND T0.CANCELED='N' AND T0.DocDate BETWEEN @dateFrom AND @dateTo
        GROUP BY S.U_rsm, T0.CardCode
        HAVING SUM(T1.GrssProfit) < 0
      ) sub
      GROUP BY rsm_code
    `, { dateFrom, dateTo }).catch(() => [])
    const rsmNegMap = Object.fromEntries(rsmNeg.map(r => [r.rsm_code, r.neg_margin_count]))

    // ───────────────────────────────────────────────────────────────────────
    // 6. EVP HERO derivations
    // ───────────────────────────────────────────────────────────────────────
    const nat       = nationalOinv[0]    || {}
    const natOdln   = nationalOdln[0]    || {}
    const natLy     = nationalLy[0]      || {}
    const natLyOdln = nationalLyOdln[0]  || {}
    const ytdVol    = Number(natOdln.ytd_vol || 0)        // ODLN = volume of record (Mat's rule)
    const ytdRev    = Number(nat.ytd_revenue || 0)
    const ytdGm     = Number(nat.ytd_gm || 0)
    const ytdInvVol = Number(nat.ytd_vol_invoiced || 0)   // OINV vol — for GM/Ton denominator
    const lyVol     = Number(natLyOdln.ytd_vol || 0)      // ODLN-vs-ODLN to match Home convention
    const lyVolInv  = Number(natLy.ytd_vol_invoiced || 0) // OINV-vs-OINV (kept for transparency)
    const ytdBudget = ytdBudgetMt(today)
    const achPct    = ytdBudget > 0 ? Math.round((ytdVol / ytdBudget) * 1000) / 10 : 0
    const vsLyPct   = lyVol > 0 ? Math.round(((ytdVol - lyVol) / lyVol) * 1000) / 10 : null
    const ppVolNat  = Number(nationalPpOdln[0]?.pp_vol || 0)
    const vsPpPctNat = ppVolNat > 0 ? Math.round(((ytdVol - ppVolNat) / ppVolNat) * 1000) / 10 : null
    const vsPpAbsNat = ytdVol - ppVolNat

    const shipDays  = countShippingDays(dateFrom, today)
    const ytdSpeed  = shipDays > 0 ? Math.round(ytdVol / shipDays) : 0

    // GM/Ton — must use OINV invoiced volume as denominator (Mat's rule)
    const gmTon = ytdInvVol > 0 ? Math.round(ytdGm / ytdInvVol) : 0

    // ───────────────────────────────────────────────────────────────────────
    // 6b. DSM roster — reps whose U_rsm is an RSM and who manage ≥1 subordinate
    //     (matches pg-admin-team inferDefaultRole: DSM vs leaf TSR).
    //     Territory rollup: DSM row ∪ reps where U_rsm = DSM SlpCode.
    // ───────────────────────────────────────────────────────────────────────
    const dsmRosterRows = await query(`
      SELECT S.SlpCode AS dsm_code, S.SlpName AS dsm_name, S.U_rsm AS rsm_code,
             NULLIF(LTRIM(RTRIM(S.Memo)), '') AS memo
      FROM OSLP S
      WHERE S.Active = 'Y'
        AND S.U_rsm IS NOT NULL
        AND S.SlpCode <> S.U_rsm
        -- NOTE: do NOT require an OSLP sub-report here. This org is 2-tier in SAP
        -- (RSM -> sales reps); TSRs live in Patrol/Supabase, not OSLP. So every
        -- active rep reporting to an RSM IS a DSM for the scorecard. The old
        -- EXISTS-subordinate check returned 0 DSMs and left every RSM unexpandable.
        AND S.U_rsm IN (
          SELECT R.SlpCode FROM OSLP R
          WHERE R.Active = 'Y' AND R.SlpCode = R.U_rsm
            AND R.SlpCode <> @director AND R.SlpCode > 0
        )
      ORDER BY S.U_rsm, S.SlpName
    `, { director: DIRECTOR_SLPCODE }).catch(() => [])

    const dsmCodes = [...new Set(dsmRosterRows.map(r => Number(r.dsm_code)).filter(n => n > 0))]
    const dsmInList = dsmCodes.length ? dsmCodes.join(',') : ''

    let dsmYtdMap = {}
    let dsmYtdOdlnMap = {}
    let dsmMtdOdlnMap = {}
    let dsmLyMap = {}
    let dsmPpMap = {}
    let dsmDsoMap = {}
    let dsmSilentMap = {}
    let dsmNegMap = {}

    if (dsmInList) {
      const caseRollup = `(CASE WHEN S.SlpCode IN (${dsmInList}) THEN S.SlpCode ELSE S.U_rsm END)`
      const territoryWhere =
        `S.Active = 'Y' AND (S.SlpCode IN (${dsmInList}) OR S.U_rsm IN (${dsmInList})) ` +
        `AND ${caseRollup} IN (${dsmInList})`

      const dsmYtdRows = await query(`
        SELECT ${caseRollup} AS dsm_key,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol,
          ISNULL(SUM(T1.LineTotal), 0)                                    AS ytd_revenue,
          ISNULL(SUM(T1.GrssProfit), 0)                                   AS ytd_gm,
          COUNT(DISTINCT T0.CardCode)                                     AS active_customers,
          COUNT(DISTINCT T0.SlpCode)                                      AS reports_count
        FROM OINV T0
        INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters} AND ${territoryWhere}
        GROUP BY ${caseRollup}
      `, { dateFrom, dateTo, region })
      dsmYtdMap = Object.fromEntries(dsmYtdRows.map(r => [Number(r.dsm_key), r]))

      const dsmOdlnYtd = await query(`
        SELECT ${caseRollup} AS dsm_key,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol_odln
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'${lineFilters} AND ${territoryWhere}
        GROUP BY ${caseRollup}
      `, { dateFrom, dateTo, region })
      dsmYtdOdlnMap = Object.fromEntries(dsmOdlnYtd.map(r => [Number(r.dsm_key), r.ytd_vol_odln]))

      const dsmOdlnMtd = await query(`
        SELECT ${caseRollup} AS dsm_key,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS mtd_vol_odln
        FROM ODLN T0
        INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate BETWEEN @monthStart AND @monthEnd AND T0.CANCELED = 'N'${lineFilters} AND ${territoryWhere}
        GROUP BY ${caseRollup}
      `, { monthStart, monthEnd, region })
      dsmMtdOdlnMap = Object.fromEntries(dsmOdlnMtd.map(r => [Number(r.dsm_key), r.mtd_vol_odln]))

      const dsmLyRows = await queryH(`
        SELECT ${caseRollup} AS dsm_key,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ly_vol
        FROM OINV T0
        INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'${lineFilters} AND ${territoryWhere}
        GROUP BY ${caseRollup}
      `, { lyStart, lyEnd, region }).catch(e => {
        console.warn('[team] DSM LY failed:', e.message); return []
      })
      dsmLyMap = Object.fromEntries(dsmLyRows.map(r => [Number(r.dsm_key), Number(r.ly_vol || 0)]))

      const dsmPpRows = await query(`
        SELECT ${caseRollup} AS dsm_key,
          ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS pp_vol
        FROM OINV T0
        INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
        LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
        INNER JOIN OSLP S ON T0.SlpCode = S.SlpCode
        WHERE T0.DocDate BETWEEN @ppFrom AND @ppTo AND T0.CANCELED = 'N'${lineFilters} AND ${territoryWhere}
        GROUP BY ${caseRollup}
      `, { ppFrom, ppTo, region }).catch(e => {
        console.warn('[team] DSM PP failed:', e.message); return []
      })
      dsmPpMap = Object.fromEntries(dsmPpRows.map(r => [Number(r.dsm_key), Number(r.pp_vol || 0)]))

      const dsmDsoRows = await query(`
        SELECT dsm_key, dso FROM (
          SELECT ${caseRollup} AS dsm_key,
            CASE WHEN SUM(T0.DocTotal) > 0
              THEN SUM(CASE WHEN T0.DocTotal > T0.PaidToDate
                            THEN T0.DocTotal - T0.PaidToDate ELSE 0 END)
                   / (SUM(T0.DocTotal) / 365.0)
              ELSE 0 END AS dso
          FROM OSLP S
          INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
          WHERE ${territoryWhere}
            AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,@anchor) AND T0.DocDate <= @anchor
          GROUP BY ${caseRollup}
        ) x WHERE x.dsm_key IN (${dsmInList})
      `, { anchor: today }).catch(() => [])
      dsmDsoMap = Object.fromEntries(dsmDsoRows.map(r => [Number(r.dsm_key), r.dso]))

      const dsmSilentRows = await query(`
        SELECT dsm_key, COUNT(*) AS silent_count FROM (
          SELECT ${caseRollup} AS dsm_key, T0.CardCode
          FROM OSLP S
          INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
          WHERE ${territoryWhere}
            AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,@anchor) AND T0.DocDate <= @anchor
          GROUP BY ${caseRollup}, T0.CardCode
          HAVING DATEDIFF(DAY, MAX(T0.DocDate), @anchor) >= 30
        ) sub
        GROUP BY dsm_key
      `, { anchor: today }).catch(() => [])
      dsmSilentMap = Object.fromEntries(dsmSilentRows.map(r => [Number(r.dsm_key), r.silent_count]))

      const dsmNegRows = await query(`
        SELECT dsm_key, COUNT(*) AS neg_margin_count FROM (
          SELECT ${caseRollup} AS dsm_key, T0.CardCode
          FROM OSLP S
          INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
          INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
          WHERE ${territoryWhere}
            AND T0.CANCELED='N' AND T0.DocDate BETWEEN @dateFrom AND @dateTo
          GROUP BY ${caseRollup}, T0.CardCode
          HAVING SUM(T1.GrssProfit) < 0
        ) sub
        GROUP BY dsm_key
      `, { dateFrom, dateTo }).catch(() => [])
      dsmNegMap = Object.fromEntries(dsmNegRows.map(r => [Number(r.dsm_key), r.neg_margin_count]))
    }

    function buildDsmScorecardRow (row) {
      const dc = Number(row.dsm_code)
      const ytd = dsmYtdMap[dc] || {}
      const ytdVolD = Number(ytd.ytd_vol || 0)
      const ytdGmD = Number(ytd.ytd_gm || 0)
      const ytdRevD = Number(ytd.ytd_revenue || 0)
      const lyVolD = dsmLyMap[dc] || 0
      const ppVolD = Number(dsmPpMap[dc] || 0)
      const mtdD = Number(dsmMtdOdlnMap[dc] || 0)
      const ytdOdD = Number(dsmYtdOdlnMap[dc] || 0)
      const dsoD = Number(dsmDsoMap[dc] || 0)
      const silentD = Number(dsmSilentMap[dc] || 0)
      const negD = Number(dsmNegMap[dc] || 0)
      const gmTonD = ytdVolD > 0 ? Math.round(ytdGmD / ytdVolD) : 0
      const vsLyD = lyVolD > 0 ? Math.round(((ytdVolD - lyVolD) / lyVolD) * 1000) / 10 : null
      const vsPpPctD = ppVolD > 0 ? Math.round(((ytdVolD - ppVolD) / ppVolD) * 1000) / 10 : null
      const vsPpAbsD = ytdVolD - ppVolD
      const speedD = shipDays > 0 ? Math.round(ytdOdD / shipDays) : 0
      const memo = row.memo ? String(row.memo).trim() : ''
      return {
        slp_code:      dc,
        name:          row.dsm_name,
        region:        memo || '—',
        bu:            '—',
        ytd_vol:       Math.round(ytdVolD),
        ytd_revenue:   Math.round(ytdRevD),
        ytd_target:    0,
        ach_pct:       0,
        vs_ly:         vsLyD,
        ly_vol:        Math.round(lyVolD),
        pp_vol:        Math.round(ppVolD),
        vs_pp_pct:     vsPpPctD,
        vs_pp:         Math.round(vsPpAbsD * 10) / 10,
        speed:         speedD,
        mtd_speed:     Math.round(mtdD),
        gm_ton:        gmTonD,
        dso:           Math.round(dsoD),
        customers:     Number(ytd.active_customers || 0),
        reports:       Number(ytd.reports_count || 0),
        silent:        silentD,
        neg_margin:    negD
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 7. RSMS array — one row per OSLP RSM (Mat = N=9 in current OSLP)
    // ───────────────────────────────────────────────────────────────────────
    const monthsSorted = [...new Set(monthlyRsmRaw.map(r => r.month))].sort()
    const recentMonths = monthsSorted.slice(-6)

    const rsms = rsmRows.map(r => {
      const rc      = r.rsm_code
      const ytd     = rsmYtdMap[rc] || {}
      const ytdVolR = Number(ytd.ytd_vol || 0)
      const ytdGmR  = Number(ytd.ytd_gm || 0)
      const ytdRevR = Number(ytd.ytd_revenue || 0)
      const lyVolR  = rsmLyMap[rc] || 0
      const ppVolR  = Number(rsmPpMap[rc] || 0)
      const mtdR    = Number(rsmMtdMap[rc] || 0)
      const ytdOdR  = Number(rsmYtdOdlnMap[rc] || 0)
      const dsoR    = Number(rsmDsoMap[rc] || 0)
      const silentR = Number(rsmSilentMap[rc] || 0)
      const negR    = Number(rsmNegMap[rc] || 0)
      const gmTonR  = ytdVolR > 0 ? Math.round(ytdGmR / ytdVolR) : 0
      const vsLyR   = lyVolR > 0 ? Math.round(((ytdVolR - lyVolR) / lyVolR) * 1000) / 10 : null
      const vsPpPctR = ppVolR > 0 ? Math.round(((ytdVolR - ppVolR) / ppVolR) * 1000) / 10 : null
      const vsPpAbsR = ytdVolR - ppVolR
      // Per-RSM YTD speed: OdlnVol / shipping_days_elapsed
      const speedR  = shipDays > 0 ? Math.round(ytdOdR / shipDays) : 0
      const dsmsForRsm = dsmRosterRows
        .filter(d => Number(d.rsm_code) === Number(rc))
        .map(buildDsmScorecardRow)
        .sort((a, b) => b.ytd_vol - a.ytd_vol)
      return {
        slp_code:  rc,
        name:      r.rsm_name,
        region:    r.dom_region || 'Other',
        ytd_vol:   Math.round(ytdVolR),
        ytd_revenue: Math.round(ytdRevR),
        ytd_target: 0,            // FLAG: real RSM-level budgets not in SAP
        ach_pct:   0,
        vs_ly:     vsLyR,
        ly_vol:    Math.round(lyVolR),
        pp_vol:    Math.round(ppVolR),
        vs_pp_pct: vsPpPctR,
        vs_pp:     Math.round(vsPpAbsR * 10) / 10,
        speed:     speedR,
        mtd_speed: Math.round(mtdR),
        gm_ton:    gmTonR,
        dso:       Math.round(dsoR),
        customers: Number(ytd.active_customers || 0),
        reports:   Number(ytd.reports_count || 0),
        silent:    silentR,
        neg_margin: negR,
        dsms:      dsmsForRsm
      }
    }).sort((a, b) => b.ytd_vol - a.ytd_vol)

    const performance_matrix = {
      months: recentMonths,
      rsms:   rsms.map(r => r.name),
      grid:   rsms.map(rsm =>
        recentMonths.map(month => {
          const k = `${rsm.slp_code}|${month}`
          return Math.round(monthlyMap[k] || 0)
        })
      )
    }

    const account_health = rsms.map(r => ({
      rsm: r.name, customers: r.customers, silent: r.silent, neg_margin: r.neg_margin
    }))

    // ───────────────────────────────────────────────────────────────────────
    // 8. RESPONSE ENVELOPE
    // ───────────────────────────────────────────────────────────────────────
    const totalReports = rsms.reduce((s, r) => s + r.reports, 0)

    const result = {
      evp: {
        name:              'Joel Durano',
        // Volume of record = ODLN. Aligns with Home / dashboard.js rule.
        ytd_vol:           Math.round(ytdVol),
        ytd_vol_invoiced:  Math.round(ytdInvVol),
        ytd_revenue:       Math.round(ytdRev),
        ytd_gm:            Math.round(ytdGm),
        gm_ton:            gmTon,
        speed:             ytdSpeed,                  // YTD-vol / shipping-days-elapsed
        shipping_days_ytd: shipDays,
        budget_mt:         ytdBudget,
        ach_pct:           achPct,
        vs_ly_pct:         vsLyPct,
        pp_vol:            Math.round(ppVolNat),
        vs_pp_pct:         vsPpPctNat,
        vs_pp:             Math.round(vsPpAbsNat * 10) / 10,
        ly_vol:            Math.round(lyVol),       // ODLN
        ly_vol_invoiced:   Math.round(lyVolInv),    // OINV (transparency)
        active_customers:  Number(nat.active_customers || 0),
        // RSM count = distinct U_rsm self-pointers (excludes Director)
        rsm_count:         rsms.length,
        // Reports = total non-RSM active reps under any RSM (DSMs/TSRs/KA/vacant)
        reports_count:     totalReports
      },
      rsms,
      performance_matrix,
      account_health,
      meta: {
        generated_at: today.toISOString(),
        applied_filters: filterMeta(region, segment),
        period,
        ref_month:    refMonthKey === 'live' ? null : refMonthKey,
        period_start: dateFrom.toISOString(),
        period_end:   dateTo.toISOString(),
        ly_window:    [lyStart.toISOString(), lyEnd.toISOString()],
        pp_window:    [ppFrom.toISOString(), ppTo.toISOString()],
        director_slpcode_excluded: DIRECTOR_SLPCODE,
        sources:      'OINV (revenue+GM) · ODLN (volume of record) · OSLP.U_rsm (hierarchy) · per-RSM dsms[] (OSLP managers w/ subordinates, territory rollup)',
        data_quality: {
          contains_proxy: true,
          proxy_fields: ['segment', 'region'],
          notes: [
            'Region filter applies to OINV/ODLN line warehouse where line-level data is present.',
            'DSO and silent-account health remain hierarchy-based because those calculations do not carry a line warehouse dimension.'
          ]
        }
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    return serverError(res, err, 'team')
  }
}
