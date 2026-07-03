const { query, queryH } = require('./_db')
const { serverError } = require('./lib/http')
const { verifySession, applyRoleFilter, getPeriodDates } = require('./_auth')
const cache = require('../lib/cache')
const { countShippingDays, getPeriodEndBound, resolveRefMonthAnchor } = require('./lib/shipping_days')
const { normalizeRegion, normalizeSegment, regionFilterSql, segmentFilterSql } = require('./lib/business_filters')
const { regionCaseSql } = require('./lib/region-map')

// FY2026 Budget — single source of truth in api/lib/budget_2026.js.
// This endpoint formerly held its own duplicated copy; consuming the shared
// module eliminates drift (e.g. the previously divergent April figure now always
// trusts budget_2026). All fields used below (fy_target_*, *_per_ton, monthly,
// quarterly, regions, volume_history) live in that module.
const { BUDGET } = require('./lib/budget_2026')

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const period = (req.query.period || 'MTD').toUpperCase()
  const refMonthRaw = typeof req.query.ref_month === 'string' ? req.query.ref_month.trim() : ''
  const refMonthKey = /^\d{4}-\d{2}$/.test(refMonthRaw) ? refMonthRaw : 'live'

  // Optional commercial filters (region = shipping warehouse, segment = DIST/KA/PET).
  // These narrow the SAP actuals only; budgeted figures stay full-scope because the
  // FY2026 budget is not broken down by segment and its regional split is its own
  // (warehouse) basis. Honored on top of the session role filter.
  const region = normalizeRegion(req.query.region)
  const segment = normalizeSegment(req.query.segment || req.query.bu)

  // Cache check — keyed by session role/region AND the requested region/segment so a
  // narrowed query never returns another scope's cached payload.
  const cacheKey = `budget_v2_${session.role}_${session.region || 'ALL'}_${region}_${segment}_${period}_${refMonthKey}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const periodOpts = refMonthKey !== 'live' ? { refMonth: refMonthKey } : {}
    const periodDates = getPeriodDates(period, periodOpts)
    const dateFrom = periodDates.dateFrom
    const dateTo = periodDates.dateTo
    const anchorDate = resolveRefMonthAnchor(refMonthKey === 'live' ? '' : refMonthKey)
    const periodEnd = getPeriodEndBound(period, anchorDate)
    const yearStart = new Date(dateTo.getFullYear(), 0, 1)
    const yearEnd = new Date(dateTo.getFullYear(), 11, 31)

    const elapsedBusinessDays = countShippingDays(dateFrom, dateTo)
    const totalBusinessDaysInYear = countShippingDays(yearStart, yearEnd)
    const pacingRatio = totalBusinessDaysInYear > 0 ? (elapsedBusinessDays / totalBusinessDaysInYear) : 0

    const budgetPacingMt = BUDGET.fy_target_mt * pacingRatio
    const budgetPacingSales = BUDGET.fy_target_sales * pacingRatio
    const budgetPacingGm = BUDGET.fy_target_gm * pacingRatio

    const baseWhere = `WHERE T0.DocDate BETWEEN @dateFrom AND @dateTo AND T0.CANCELED = 'N'`
    // Layer: role scope first, then optional region (T1.WhsCode) + segment (T0.CardName/SlpCode).
    const commercialFilter = regionFilterSql(region, 'T1') + segmentFilterSql(segment, 'T0')
    const filteredWhere = applyRoleFilter(session, baseWhere) + commercialFilter
    const sqlParams = region !== 'ALL' ? { region } : {}

    // --- Period Actual from SAP ---
    const periodActual = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS actual_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS actual_sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS actual_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { dateFrom, dateTo, ...sqlParams })

    // --- LY same-period actual ---
    const lyFrom = new Date(dateFrom)
    lyFrom.setFullYear(lyFrom.getFullYear() - 1)
    const lyTo = new Date(dateTo)
    lyTo.setFullYear(lyTo.getFullYear() - 1)
    const lyPeriodActual = await queryH(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS ly_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS ly_sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS ly_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE T0.DocDate BETWEEN @lyStart AND @lyEnd AND T0.CANCELED = 'N'
    `, { lyStart: lyFrom, lyEnd: lyTo }).catch(e => {
      console.warn('[budget] LY period query failed:', e.message); return [{}]
    })

    // --- LY full-year actual (for FY vs FY26 budget comparison) ---
    const lyFullYearActual = await queryH(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS fy_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS fy_sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS fy_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      WHERE YEAR(T0.DocDate) = @ly AND T0.CANCELED = 'N'
    `, { ly: dateTo.getFullYear() - 1 }).catch(e => {
      console.warn('[budget] LY FY query failed:', e.message); return [{}]
    })

    // --- Monthly actual ---
    const monthlyActual = await query(`
      SELECT
        MONTH(T0.DocDate)                                                  AS month_num,
        FORMAT(T0.DocDate, 'MMM')                                          AS month_name,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                       AS sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                      AS gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY MONTH(T0.DocDate), FORMAT(T0.DocDate, 'MMM')
      ORDER BY month_num ASC
    `, { dateFrom, dateTo, ...sqlParams })

    // --- Actual by region (YTD, approximate via warehouse) ---
    const regionActual = await query(`
      SELECT
        ${regionCaseSql('T1')}                                                                AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                       AS sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                      AS gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        ${regionCaseSql('T1')}
    `, { dateFrom, dateTo, ...sqlParams })

    // Build results
    const actual = periodActual[0] || { actual_vol: 0, actual_sales: 0, actual_gm: 0 }
    const actualMt = Number(actual.actual_vol || 0)
    const actualSales = Number(actual.actual_sales || 0)
    const actualGm = Number(actual.actual_gm || 0)
    const achievement_pct = budgetPacingMt > 0 ? Math.round((actualMt / budgetPacingMt) * 100) : 0

    // P&L summary rows
    const currentMonth = dateTo.getMonth()
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const pl_months = []
    for (let i = dateFrom.getMonth(); i <= Math.min(currentMonth, 11); i++) {
      const actual = monthlyActual.find(m => m.month_num === i + 1)
      pl_months.push({
        month: monthNames[i],
        vol_actual: actual ? Math.round(actual.vol) : 0,
        vol_budget: BUDGET.monthly[i],
        sales_actual: actual ? actual.sales : 0,
        sales_budget: Math.round(BUDGET.monthly[i] * BUDGET.net_sales_per_ton),
        gm_actual: actual ? actual.gm : 0,
        gm_budget: Math.round(BUDGET.monthly[i] * BUDGET.gm_per_ton)
      })
    }

    // Achievement by region
    const achievement_by_region = ['Visayas', 'Mindanao', 'Luzon'].map(region => {
      const budgetData = BUDGET.regions[region]
      const actual = regionActual.find(r => r.region === region) || { vol: 0, sales: 0, gm: 0 }
      const pacedRegionBudget = budgetData.fy26 * pacingRatio

      return {
        region,
        ytd_actual: Math.round(actual.vol),
        ytd_budget: Math.round(pacedRegionBudget),
        ach_pct: pacedRegionBudget > 0 ? Math.round((actual.vol / pacedRegionBudget) * 100) : 0,
        fy_budget: budgetData.fy26
      }
    })

    // GM achievement by region
    const gm_by_region = ['Visayas', 'Mindanao', 'Luzon'].map(region => {
      const actual = regionActual.find(r => r.region === region) || { vol: 0, gm: 0 }
      const budgetVol = achievement_by_region.find(r => r.region === region)?.ytd_budget || 0
      const gmBudget = budgetVol * BUDGET.gm_per_ton
      const gm_ton = actual.vol > 0 ? Math.round(actual.gm / actual.vol) : 0

      return {
        region,
        gm_actual: Math.round(actual.gm),
        gm_budget: Math.round(gmBudget),
        ach_pct: gmBudget > 0 ? Math.round((actual.gm / gmBudget) * 100) : 0,
        gm_ton
      }
    })

    // Monthly actual vs budget for chart
    const monthly_actual_vs_budget = {
      months: pl_months.map(m => m.month),
      actual: pl_months.map(m => m.vol_actual),
      budget: pl_months.map(m => m.vol_budget)
    }

    // Budgeted volume table
    const budgeted_volume = {
      regions: Object.entries(BUDGET.regions).map(([region, data]) => ({
        region,
        q1: data.quarterly[0],
        q2: data.quarterly[1],
        q3: data.quarterly[2],
        q4: data.quarterly[3],
        fy26: data.fy26,
        fy25: data.fy25,
        growth_pct: data.growth_pct,
        sub_rows: data.sub.map(s => ({
          name: s.name,
          q1: s.quarterly[0],
          q2: s.quarterly[1],
          q3: s.quarterly[2],
          q4: s.quarterly[3],
          fy26: s.fy26,
          growth_pct: s.growth_pct
        }))
      })),
      total: {
        q1: BUDGET.quarterly[0],
        q2: BUDGET.quarterly[1],
        q3: BUDGET.quarterly[2],
        q4: BUDGET.quarterly[3],
        fy26: BUDGET.fy_target_mt,
        fy25: 136972,
        growth_pct: 37.4
      }
    }

    // P&L summary
    const pl_summary = {
      months: pl_months.map(m => m.month),
      rows: [
        {
          label: 'Volume (MT)',
          values: pl_months.map(m => m.vol_actual),
          ytd_actual: Math.round(actualMt),
          ytd_budget: Math.round(budgetPacingMt),
          ach_pct: achievement_pct,
          fy_budget: BUDGET.fy_target_mt
        },
        {
          label: 'Net Sales',
          values: pl_months.map(m => m.sales_actual),
          ytd_actual: Math.round(actualSales),
          ytd_budget: Math.round(budgetPacingSales),
          ach_pct: budgetPacingSales > 0 ? Math.round((actualSales / budgetPacingSales) * 100) : 0,
          fy_budget: BUDGET.fy_target_sales
        },
        {
          label: 'COGS',
          values: pl_months.map(m => -Math.round(m.sales_actual - m.gm_actual)),
          ytd_actual: -Math.round(actualSales - actualGm),
          ytd_budget: -Math.round(budgetPacingSales - budgetPacingGm),
          ach_pct: (budgetPacingSales - budgetPacingGm) > 0
            ? Math.round(((actualSales - actualGm) / (budgetPacingSales - budgetPacingGm)) * 100)
            : 0,
          fy_budget: -Math.round(BUDGET.fy_target_mt * BUDGET.cogs_per_ton)
        },
        {
          label: 'Gross Margin',
          values: pl_months.map(m => m.gm_actual),
          ytd_actual: Math.round(actualGm),
          ytd_budget: Math.round(budgetPacingGm),
          ach_pct: budgetPacingGm > 0 ? Math.round((actualGm / budgetPacingGm) * 100) : 0,
          fy_budget: BUDGET.fy_target_gm
        }
      ]
    }

    const lyPeriod = lyPeriodActual[0] || {}
    const lyFy  = lyFullYearActual[0] || {}
    const pct = (a, b) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : 0

    const result = {
      hero: {
        period,
        period_start: dateFrom.toISOString(),
        period_end: dateTo.toISOString(),
        annual_budget_mt: BUDGET.fy_target_mt,
        annual_budget_sales: BUDGET.fy_target_sales,
        annual_budget_gm: BUDGET.fy_target_gm,
        actual_mt: Math.round(actualMt),
        actual_sales: Math.round(actualSales),
        actual_gm: Math.round(actualGm),
        budget_pacing_mt: Math.round(budgetPacingMt),
        budget_pacing_sales: Math.round(budgetPacingSales),
        budget_pacing_gm: Math.round(budgetPacingGm),
        actual_vs_pacing_pct: achievement_pct,
        actual_vs_annual_pct: BUDGET.fy_target_mt > 0 ? Math.round((actualMt / BUDGET.fy_target_mt) * 100) : 0,
        elapsed_business_days_in_period: elapsedBusinessDays,
        total_business_days_in_year: totalBusinessDaysInYear,
        fy_target_mt: BUDGET.fy_target_mt,
        fy_target_sales: BUDGET.fy_target_sales,
        fy_target_gm: BUDGET.fy_target_gm,
        // Back-compat aliases for existing UI ids.
        ytd_actual: Math.round(actualMt),
        ytd_budget: Math.round(budgetPacingMt),
        achievement_pct,
        // LY comparisons
        ytd_ly_actual:  Math.round(lyPeriod.ly_vol || 0),
        ytd_vs_ly_pct:  pct(actualMt, lyPeriod.ly_vol || 0),
        ly_fy_vol:      Math.round(lyFy.fy_vol || 0),
        ly_fy_sales:    Math.round(lyFy.fy_sales || 0),
        ly_fy_gm:       Math.round(lyFy.fy_gm || 0)
      },
      volume_history: BUDGET.volume_history,
      budgeted_volume,
      pl_summary,
      achievement_by_region,
      monthly_actual_vs_budget,
      gm_by_region
    }

    cache.set(cacheKey, result, 300)
    res.json(result)
  } catch (err) {
    return serverError(res, err, 'budget')
  }
}
