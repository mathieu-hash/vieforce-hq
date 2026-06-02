// FY2026 sales budget source used by HQ dashboard endpoints.
// Keep this module as the single source for volume, sales, GM, and region targets.

const BUDGET = {
  fy_target_mt: 188266,
  fy_target_sales: 5975000000,
  fy_target_gm: 1233000000,
  net_sales_per_ton: 31735,
  cogs_per_ton: 25185,
  gm_per_ton: 6550,
  gm_pct: 20.6,

  monthly: [14010, 12999, 14791, 15334, 15536, 15005, 16735, 16247, 17097, 18391, 17211, 16981],
  quarterly: [41800, 45875, 50079, 52572],

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

const BUDGET_2026 = {
  annual: BUDGET.fy_target_mt,
  annual_mt: BUDGET.fy_target_mt,
  annual_sales: BUDGET.fy_target_sales,
  annual_gm: BUDGET.fy_target_gm,
  monthly: BUDGET.monthly,
  monthly_mt: BUDGET.monthly,
  quarterly: BUDGET.quarterly
}

function getMonthlyBudgetMt(monthIdx) {
  const i = Math.max(0, Math.min(11, Number(monthIdx) || 0))
  return BUDGET.monthly[i] || 0
}

function getYtdBudgetMt(anchorDate) {
  const d = anchorDate || new Date()
  const monthIdx = d.getMonth()
  return BUDGET.monthly.slice(0, monthIdx + 1).reduce((sum, v) => sum + v, 0)
}

function getProratedYtdBudgetMt(anchorDate) {
  const d = anchorDate || new Date()
  const monthIdx = d.getMonth()
  const completed = BUDGET.monthly.slice(0, monthIdx).reduce((sum, v) => sum + v, 0)
  const daysInMonth = new Date(d.getFullYear(), monthIdx + 1, 0).getDate()
  return Math.round(completed + getMonthlyBudgetMt(monthIdx) * (d.getDate() / daysInMonth))
}

function getPeriodTargetMt(period, anchorDate) {
  const d = anchorDate || new Date()
  const monthIdx = d.getMonth()
  const quarterIdx = Math.floor(monthIdx / 3)
  switch (String(period || 'MTD').toUpperCase()) {
    case '7D': return Math.round(getMonthlyBudgetMt(monthIdx) * 7 / 30)
    case 'QTD': return BUDGET.quarterly[quarterIdx] || 0
    case 'YTD': return BUDGET.fy_target_mt
    case 'MTD':
    default: return getMonthlyBudgetMt(monthIdx)
  }
}

function budgetMeta() {
  return {
    id: 'FY2026_OFFICIAL_V1',
    source: 'Sales Volume Budget 2026',
    annual_mt: BUDGET.fy_target_mt,
    annual_sales: BUDGET.fy_target_sales,
    annual_gm: BUDGET.fy_target_gm
  }
}

module.exports = {
  BUDGET,
  BUDGET_2026,
  getMonthlyBudgetMt,
  getYtdBudgetMt,
  getProratedYtdBudgetMt,
  getPeriodTargetMt,
  budgetMeta
}
