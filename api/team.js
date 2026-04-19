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
const { verifySession, verifyServiceToken } = require('./_auth')
const cache = require('../lib/cache')

// FY2026 monthly volume budget (mirrors api/dashboard.js + api/budget.js).
// Single source of truth would ideally be a shared module — duplicated here
// to keep the rewrite self-contained for the demo.
const BUDGET_2026 = {
  annual_mt: 188266,
  monthly_mt: [
    13933, 13933, 13934,   // Q1 Jan, Feb, Mar
    15061, 15061, 15062,   // Q2 Apr, May, Jun
    16463, 16463, 16463,   // Q3 Jul, Aug, Sep
    17298, 17298, 17297    // Q4 Oct, Nov, Dec
  ]
}

// Director SlpCode (Joel Durano). Excluded from RSM list — he IS the EVP.
const DIRECTOR_SLPCODE = 3

function countShippingDays(from, to) {
  // Mon-Sat workdays inclusive. v1 ignores PH holidays (IT will provide cal).
  let n = 0
  const cur = new Date(from); cur.setHours(0, 0, 0, 0)
  const end = new Date(to);   end.setHours(0, 0, 0, 0)
  while (cur <= end) {
    if (cur.getDay() !== 0) n++   // 0 = Sunday
    cur.setDate(cur.getDate() + 1)
  }
  return n
}

function ytdBudgetMt(today) {
  // Sum completed months + day-prorated current month. Matches Joel's natural
  // "where should we be by today?" mental model better than month-end sums.
  const m = today.getMonth()           // 0-indexed
  const d = today.getDate()
  const completed = BUDGET_2026.monthly_mt.slice(0, m).reduce((s, x) => s + x, 0)
  const daysInMonth = new Date(today.getFullYear(), m + 1, 0).getDate()
  const proRated = BUDGET_2026.monthly_mt[m] * (d / daysInMonth)
  return Math.round(completed + proRated)
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const cacheKey = `team_v2_${req.url}_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const today    = new Date()
    const ytdStart = new Date(today.getFullYear(), 0, 1)
    const lyStart  = new Date(today.getFullYear() - 1, 0, 1)
    const lyEnd    = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

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
      WHERE T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'
    `, { ytdStart })

    const nationalOdln = await query(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'
    `, { ytdStart })

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
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'
    `, { lyStart, lyEnd }).catch(e => {
      console.warn('[team] LY national OINV failed:', e.message); return [{}]
    })

    const nationalLyOdln = await queryH(`
      SELECT ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0) AS ytd_vol
      FROM ODLN T0
      INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'
    `, { lyStart, lyEnd }).catch(e => {
      console.warn('[team] LY national ODLN failed:', e.message); return [{}]
    })

    // ───────────────────────────────────────────────────────────────────────
    // 2. RSM ROSTER — discover RSMs from OSLP.U_rsm self-references
    // ───────────────────────────────────────────────────────────────────────
    const rsmRows = await query(`
      SELECT R.SlpCode AS rsm_code, R.SlpName AS rsm_name
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
        AND T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'
      GROUP BY S.U_rsm
    `, { ytdStart })
    const rsmYtdMap = Object.fromEntries(rsmYtd.map(r => [r.rsm_code, r]))

    // MTD ODLN per RSM (current calendar month)
    const rsmMtdOdln = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS mtd_vol_odln
      FROM OSLP S
      INNER JOIN ODLN T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate >= @monthStart AND T0.CANCELED = 'N'
      GROUP BY S.U_rsm
    `, { monthStart })
    const rsmMtdMap = Object.fromEntries(rsmMtdOdln.map(r => [r.rsm_code, r.mtd_vol_odln]))

    // YTD ODLN per RSM (for YTD-speed denominator)
    const rsmYtdOdln = await query(`
      SELECT
        S.U_rsm                                                          AS rsm_code,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0, 0)   AS ytd_vol_odln
      FROM OSLP S
      INNER JOIN ODLN T0 ON T0.SlpCode = S.SlpCode
      INNER JOIN DLN1 T1 ON T1.DocEntry = T0.DocEntry
      LEFT JOIN OITM I ON I.ItemCode = T1.ItemCode
      WHERE S.Active = 'Y' AND S.U_rsm IS NOT NULL
        AND T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'
      GROUP BY S.U_rsm
    `, { ytdStart })
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
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'
      GROUP BY S.SlpName
    `, { lyStart, lyEnd }).catch(e => {
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
        AND T0.DocDate >= DATEADD(MONTH, -6, GETDATE()) AND T0.CANCELED = 'N'
      GROUP BY S.U_rsm, FORMAT(T0.DocDate, 'yyyy-MM')
    `).catch(e => { console.warn('[team] monthly grid failed:', e.message); return [] })
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
        AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,GETDATE())
      GROUP BY S.U_rsm
    `).catch(() => [])
    const rsmDsoMap = Object.fromEntries(rsmDso.map(r => [r.rsm_code, r.dso]))

    const rsmSilent = await query(`
      SELECT rsm_code, COUNT(*) AS silent_count
      FROM (
        SELECT S.U_rsm AS rsm_code, T0.CardCode
        FROM OSLP S
        INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
        WHERE S.Active='Y' AND S.U_rsm IS NOT NULL
          AND T0.CANCELED='N' AND T0.DocDate >= DATEADD(YEAR,-1,GETDATE())
        GROUP BY S.U_rsm, T0.CardCode
        HAVING DATEDIFF(DAY, MAX(T0.DocDate), GETDATE()) >= 30
      ) sub
      GROUP BY rsm_code
    `).catch(() => [])
    const rsmSilentMap = Object.fromEntries(rsmSilent.map(r => [r.rsm_code, r.silent_count]))

    const rsmNeg = await query(`
      SELECT rsm_code, COUNT(*) AS neg_margin_count
      FROM (
        SELECT S.U_rsm AS rsm_code, T0.CardCode
        FROM OSLP S
        INNER JOIN OINV T0 ON T0.SlpCode = S.SlpCode
        INNER JOIN INV1 T1 ON T1.DocEntry = T0.DocEntry
        WHERE S.Active='Y' AND S.U_rsm IS NOT NULL
          AND T0.CANCELED='N' AND T0.DocDate >= @ytdStart
        GROUP BY S.U_rsm, T0.CardCode
        HAVING SUM(T1.GrssProfit) < 0
      ) sub
      GROUP BY rsm_code
    `, { ytdStart }).catch(() => [])
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

    const shipDays  = countShippingDays(ytdStart, today)
    const ytdSpeed  = shipDays > 0 ? Math.round(ytdVol / shipDays) : 0

    // GM/Ton — must use OINV invoiced volume as denominator (Mat's rule)
    const gmTon = ytdInvVol > 0 ? Math.round(ytdGm / ytdInvVol) : 0

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
      const mtdR    = Number(rsmMtdMap[rc] || 0)
      const ytdOdR  = Number(rsmYtdOdlnMap[rc] || 0)
      const dsoR    = Number(rsmDsoMap[rc] || 0)
      const silentR = Number(rsmSilentMap[rc] || 0)
      const negR    = Number(rsmNegMap[rc] || 0)
      const gmTonR  = ytdVolR > 0 ? Math.round(ytdGmR / ytdVolR) : 0
      const vsLyR   = lyVolR > 0 ? Math.round(((ytdVolR - lyVolR) / lyVolR) * 1000) / 10 : null
      // Per-RSM YTD speed: OdlnVol / shipping_days_elapsed
      const speedR  = shipDays > 0 ? Math.round(ytdOdR / shipDays) : 0
      return {
        slp_code:  rc,
        name:      r.rsm_name,
        ytd_vol:   Math.round(ytdVolR),
        ytd_revenue: Math.round(ytdRevR),
        ytd_target: 0,            // FLAG: real RSM-level budgets not in SAP
        ach_pct:   0,
        vs_ly:     vsLyR,
        ly_vol:    Math.round(lyVolR),
        speed:     speedR,
        mtd_speed: Math.round(mtdR),
        gm_ton:    gmTonR,
        dso:       Math.round(dsoR),
        customers: Number(ytd.active_customers || 0),
        reports:   Number(ytd.reports_count || 0),
        silent:    silentR,
        neg_margin: negR
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
        ytd_start:    ytdStart.toISOString(),
        ly_window:    [lyStart.toISOString(), lyEnd.toISOString()],
        director_slpcode_excluded: DIRECTOR_SLPCODE,
        sources:      'OINV (revenue+GM) · ODLN (volume of record) · OSLP.U_rsm (hierarchy)'
      }
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    console.error('API error [team]:', err.message, err.stack)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
