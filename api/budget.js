const { query } = require('./_db')
const { verifySession, getPeriodDates, applyRoleFilter } = require('./_auth')
const cache = require('../lib/cache')

// FY2026 Budget — from Sales Volume Budget 2026 Excel
const BUDGET = {
  fy_target_mt: 188266,
  fy_target_sales: 5975000000,  // ₱5.975B
  fy_target_gm: 1233000000,    // ₱1.233B
  net_sales_per_ton: 31735,
  cogs_per_ton: 25185,
  gm_per_ton: 6550,
  gm_pct: 20.6,

  // Monthly budget in MT (Jan-Dec)
  monthly: [14010, 12999, 14791, 15334, 15536, 15005, 16735, 16247, 17097, 18391, 17211, 16981],

  // Quarterly
  quarterly: [41800, 45875, 50079, 52572],

  // Regional breakdown
  regions: {
    Visayas: {
      fy26: 76271, fy25: 52716, growth_pct: 45,
      quarterly: [17008, 18091, 19637, 21535],
      sub: [
        { name: 'Hogs', quarterly: [9308, 9975, 10913, 13065], fy26: 46270, growth_pct: 61 },
        { name: 'Poultry', quarterly: [4089, 4469, 4853, 5436], fy26: 18847, growth_pct: 25 },
        { name: 'Gamefowl', quarterly: [1686, 1794, 1946, 2135], fy26: 7562, growth_pct: 10 }
      ]
    },
    Mindanao: {
      fy26: 65110, fy25: 46901, growth_pct: 39,
      quarterly: [14844, 16082, 17210, 16974],
      sub: [
        { name: 'Hogs', quarterly: [8578, 9293, 9906, 9848], fy26: 37625, growth_pct: 58 },
        { name: 'Poultry', quarterly: [4218, 4786, 5123, 5052], fy26: 19379, growth_pct: 30 },
        { name: 'Gamefowl', quarterly: [1531, 1658, 1775, 1750], fy26: 6714, growth_pct: 10 }
      ]
    },
    Luzon: {
      fy26: 46886, fy25: 36901, growth_pct: 27,
      quarterly: [11161, 12063, 11608, 12054],
      sub: [
        { name: 'Hogs', quarterly: [7214, 7797, 7506, 7785], fy26: 30302, growth_pct: 65 },
        { name: 'Poultry', quarterly: [2809, 3017, 2966, 3064], fy26: 12656, growth_pct: 27 },
        { name: 'Gamefowl', quarterly: [943, 989, 964, 988], fy26: 3066, growth_pct: 7 }
      ]
    }
  },

  // Volume history (K MT) 2017-2026
  volume_history: [
    { year: 2017, volume_k: 4 },
    { year: 2018, volume_k: 25 },
    { year: 2019, volume_k: 68 },
    { year: 2020, volume_k: 80 },
    { year: 2021, volume_k: 70 },
    { year: 2022, volume_k: 90 },
    { year: 2023, volume_k: 90 },
    { year: 2024, volume_k: 110 },
    { year: 2025, volume_k: 136 },
    { year: 2026, volume_k: 188 }
  ]
}

function getYTDBudget() {
  const now = new Date()
  const currentMonth = now.getMonth() // 0-11
  let ytd = 0
  for (let i = 0; i <= currentMonth; i++) {
    ytd += BUDGET.monthly[i]
  }
  return ytd
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  // Auth
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  // Cache check
  const cacheKey = `budget_${session.role}_${session.region || 'ALL'}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    const ytdStart = new Date(new Date().getFullYear(), 0, 1)
    const baseWhere = `WHERE T0.DocDate >= @ytdStart AND T0.CANCELED = 'N'`
    const filteredWhere = applyRoleFilter(session, baseWhere)

    // --- YTD Actual from SAP ---
    const ytdActual = await query(`
      SELECT
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)   AS ytd_vol,
        ISNULL(SUM(T1.LineTotal), 0)                                      AS ytd_sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                     AS ytd_gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
    `, { ytdStart })

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
    `, { ytdStart })

    // --- Actual by region (YTD, approximate via warehouse) ---
    const regionActual = await query(`
      SELECT
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END                                                                AS region,
        ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)    AS vol,
        ISNULL(SUM(T1.LineTotal), 0)                                       AS sales,
        ISNULL(SUM(T1.GrssProfit), 0)                                      AS gm
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
      ${filteredWhere}
      GROUP BY
        CASE
          WHEN T1.WhsCode IN ('AC','ACEXT','BAC') THEN 'Luzon'
          WHEN T1.WhsCode IN ('HOREB','ARGAO','ALAE') THEN 'Visayas'
          WHEN T1.WhsCode IN ('BUKID','CCPC') THEN 'Mindanao'
          ELSE 'Other'
        END
    `, { ytdStart })

    // Build results
    const ytd = ytdActual[0] || { ytd_vol: 0, ytd_sales: 0, ytd_gm: 0 }
    const ytdBudget = getYTDBudget()
    const achievement_pct = ytdBudget > 0 ? Math.round((ytd.ytd_vol / ytdBudget) * 100) : 0

    // P&L summary rows
    const currentMonth = new Date().getMonth()
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const pl_months = []
    for (let i = 0; i <= Math.min(currentMonth, 11); i++) {
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
    const now = new Date()
    const quarter = Math.floor(now.getMonth() / 3)
    const achievement_by_region = ['Visayas', 'Mindanao', 'Luzon'].map(region => {
      const budgetData = BUDGET.regions[region]
      const actual = regionActual.find(r => r.region === region) || { vol: 0, sales: 0, gm: 0 }
      // YTD budget = sum of quarterly budgets up to current quarter + prorated current quarter
      let ytdRegionBudget = 0
      for (let q = 0; q < quarter; q++) {
        ytdRegionBudget += budgetData.quarterly[q]
      }
      // Add prorated current quarter
      const monthInQuarter = now.getMonth() % 3
      ytdRegionBudget += Math.round(budgetData.quarterly[quarter] * ((monthInQuarter + 1) / 3))

      return {
        region,
        ytd_actual: Math.round(actual.vol),
        ytd_budget: ytdRegionBudget,
        ach_pct: ytdRegionBudget > 0 ? Math.round((actual.vol / ytdRegionBudget) * 100) : 0,
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
          ytd_actual: Math.round(ytd.ytd_vol),
          ytd_budget: ytdBudget,
          ach_pct: achievement_pct,
          fy_budget: BUDGET.fy_target_mt
        },
        {
          label: 'Net Sales',
          values: pl_months.map(m => m.sales_actual),
          ytd_actual: Math.round(ytd.ytd_sales),
          ytd_budget: Math.round(ytdBudget * BUDGET.net_sales_per_ton),
          ach_pct: ytdBudget > 0 ? Math.round((ytd.ytd_sales / (ytdBudget * BUDGET.net_sales_per_ton)) * 100) : 0,
          fy_budget: BUDGET.fy_target_sales
        },
        {
          label: 'COGS',
          values: pl_months.map(m => -Math.round(m.sales_actual - m.gm_actual)),
          ytd_actual: -Math.round(ytd.ytd_sales - ytd.ytd_gm),
          ytd_budget: -Math.round(ytdBudget * BUDGET.cogs_per_ton),
          ach_pct: ytdBudget > 0 ? Math.round(((ytd.ytd_sales - ytd.ytd_gm) / (ytdBudget * BUDGET.cogs_per_ton)) * 100) : 0,
          fy_budget: -Math.round(BUDGET.fy_target_mt * BUDGET.cogs_per_ton)
        },
        {
          label: 'Gross Margin',
          values: pl_months.map(m => m.gm_actual),
          ytd_actual: Math.round(ytd.ytd_gm),
          ytd_budget: Math.round(ytdBudget * BUDGET.gm_per_ton),
          ach_pct: ytdBudget > 0 ? Math.round((ytd.ytd_gm / (ytdBudget * BUDGET.gm_per_ton)) * 100) : 0,
          fy_budget: BUDGET.fy_target_gm
        }
      ]
    }

    const result = {
      hero: {
        fy_target_mt: BUDGET.fy_target_mt,
        fy_target_sales: BUDGET.fy_target_sales,
        fy_target_gm: BUDGET.fy_target_gm,
        ytd_actual: Math.round(ytd.ytd_vol),
        ytd_budget: ytdBudget,
        achievement_pct
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
    console.error('API error [budget]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
