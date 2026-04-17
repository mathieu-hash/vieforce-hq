# API Endpoint Shapes — Captured 2026-04-17 from rev 00031-jud
Session: 4bc1c7c0 (Rico Abante TSR) — all calls returned HTTP 200.

## /api/dashboard (1.6KB, 8.5s cold)
Top-level keys:
- revenue, volume_bags, volume_mt, gross_margin, gm_per_bag, gmt
- previous_period: {revenue, volume_mt, gross_margin, gmt}
- last_year: {revenue:0, volume_mt:0, gross_margin:0, gmt:0}  ← all zeros
- delta_pct: {revenue:-58, volume_mt:-58.9, gross_margin:-53.8, gmt:12.5}
- delta_pct_ly: {revenue:0, volume_mt:0, gross_margin:0, gmt:0}  ← all zeros (no LY data)
- ytd: {revenue, volume_mt, gross_margin, gmt}
- budget: {fy_mt, fy_sales, fy_gm, mtd_mt, ytd_mt, ytd_sales, ytd_gm, months_elapsed}
- ar_balance, ar_active_balance, ar_delinquent_balance
- dso_total:45, dso_active:30
- pending_po: {total_mt, total_value, total_orders, oldest_days:90}
- region_performance: [4 items] {region, vol, gm_ton}  ← only 2 fields per region (no sales!)
- top_customers: [5 items] {name, vol, revenue}
- margin_alerts: {critical:6, warning:6, watch:19, healthy:330}
**MISSING for UI:** bu_split[], net_sales by region, monthly_trend region-split

## /api/sales (22KB, 1.1s)
- by_brand: [113 items] {brand, volume_bags, volume_mt, revenue, gm_per_bag, gmt}
- top_customers: [20 items] {customer_code, customer_name, volume_bags, volume_mt, revenue}
- monthly_trend: [4 items] {month:"2026-01", volume_bags, volume_mt, revenue}  ← only 4 months
- pending_po: {summary{total_mt,total_orders,customers_count,oldest_days}, by_brand[45], by_region[4], top_customers[10]}
**MISSING for UI:** kpis (volume_mt, revenue, ytd_volume, gmt, pending), gm_matrix (9×7), vs_ly per dimension, by_district[], by_product[], by_sales_group[], by_bu[]

## /api/ar (182KB, 1.2s)
- dso, dso_active:30, dso_total:45, dso_7d_ago:24, dso_variation:6
- total_balance:761M, active_balance:500M, delinquent_balance:261M
- ar_7d_ago, ar_variation
- account_status: {active:545, delinquent:126, inactive:2}
- active_customer_count:545, delinquent_customer_count:126
- buckets: {current, d1_30, d31_60, d61_90, d91_120, d121_365, over_1y}
- by_region: [4] {region, ar, sales_90d, dso}
- clients: [675] {CardCode, CardName, bp_status, frozen_for, is_delinquent, terms, balance, ...}
- formula: {dso, active, delinq}
**Has everything UI needs for AR.**

## /api/inventory (818KB, 2s)
- plants: [43] {plant_code, plant_name, total_on_hand, total_committed, total_on_order, total_available}
- items: [4141] {plant_code, plant_name, item_code, item_name, qty_on_hand, qty_committed, qty_on_order, qty_available}
- by_region: [4] {region, on_hand, committed, on_order, available}
- negative_avail_count:491
- cover_days: {national:387}
**MISSING for UI:** by_sales_group[], summary KPIs object (Pending PO total, On Production)

## /api/speed (4.6KB, 0.9s)
- period:"MTD", period_volume_mt, shipping_days_*, daily_pullout, projected_period_volume, vs_prior_period_pct, prior_period_volume_mt, prior_period_daily_pullout
- mtd_actual, days_elapsed:15, days_total:26, days_remaining:11
- projected_mtd:13471, last_month_full_mt:18132, last_month_same_day_mt:8692, vs_last_month_volume, vs_last_month_pct
- actual_mt, speed_per_day, elapsed_days, total_days, remaining_days, projected_mt, target_mt:15061, pct_of_target:89
- daily: [13] {ship_date, day_name, daily_mt}  ← Daily Pullout chart data
- plant_breakdown: [13] {plant, mtd}
- rsm_speed: [20] {rsm, current_vol}  ← only 2 fields, UI expects more
- feed_type_speed: [15] {brand, current_vol}  ← only 2 fields
- weekly_matrix: {weeks:[7], plants:[14], grid:[14×7]}
**Speed page hardcodes MTD; topbar period override blocked by spec (intentional).**

## /api/customers (10KB)
- customers: [50] {CardCode, CardName, Phone1, City, ytd_revenue, ytd_bags, ytd_volume, last_order_date}
- total:1382, page:1, pages:28
**MISSING for UI:** rsm/SlpName per customer, region, status (active/delinquent), gm_ton, BU

## /api/customer?id=CA000838 (30KB, 0.9s)
- info: {CardCode, CardName, Phone1/2, Cellular, email, City, Address, SlpCode, rsm}
- ytd_sales: {revenue, volume_bags, volume, orders_count}
- kpis: {ytd_vol, mtd_vol, ytd_sales, mtd_sales, gm_ton, dso, avg_order, frequency}
- ar_invoices: [3] {DocNum, DocDate, DocDueDate, DocTotal, PaidToDate, balance, days_overdue}
- product_breakdown: [207] {ItemCode, item_name, volume_bags, volume, revenue}
- recent_orders: [10] {DocNum, DocDate, DocTotal, DocStatus, PaidToDate, total_qty}
- cy_vs_ly: {months:[12], cy_vol:[12], ly_vol:[12]}
- monthly_table: [12] {month, vol_cy, vol_ly, vs_ly_pct, sales, gm_ton}
- account_age_days, rank_by_volume
**MISSING for UI:** insight cards (Growth Signal, SKU Mix, Credit Watch, Opportunity), AR aging breakdown, sales/gm trend chart data

## /api/margin (52KB, 1.9s)
- hero: {negative_gp_total:-146646, revenue_at_risk:628M, critical_count:36, warning_count:257}
- kpis: {critical:36, warning:257, watch:106, healthy:101, natl_gm_ton:5510, natl_gp_pct:10.1, best_region, worst_region}
- critical: [36] {code, customer, sales, vol, gp, gp_pct, gm_ton, rep}
- warning: [257] {same fields}
- by_region: [4] {region, sales, vol, gp, gp_pct, gm_ton}
- by_brand: [20] {brand, sales, vol, gp_pct, gm_ton}
- by_plant: [19] {plant, vol, gp_pct, gm_ton}
- worst_skus: [10] {sku, name, vol_bags, gp_pct, gm_ton}
**MISSING for UI:** by_sales_group[], by_bu[], sku_breakdown nested in critical[], GM/Ton trend chart series, GP% heatmap matrix

## /api/intelligence (10KB, 3.7s)
- hero: {whitespace_total, at_risk_total, avg_health_score:66, total_active:788}
- kpis: {silent_30d:10, vol_drop:2, growing:10, avg_skus_per_cust:8, avg_brands_per_cust:14.1}
- brand_coverage: [17] {brand, customers, penetration_pct, vol_per_cust, whitespace_count, est_opportunity}
- horizontal_targets: [20] {customer, code, skus, brands, vol}
- buying_patterns: [5] {pattern, count, pct, avg_vol, signal}
- sku_penetration_matrix: {customers:[15], categories:[10], grid:[15×10]}
- behavioral_alerts: {silent:[10], drops:[2], growing:[10]}
- health_distribution: [5] {band, count, pct, volume, revenue}  ← all bands return 0!
- reorder_predictions: [15] {customer, code, avg_interval_days, days_since_last, days_overdue, est_vol, status}
**MISSING for UI:** vertical_targets[] (UI shows separate Vertical Growth box)

## /api/team (2.8KB, 1.4s)
- evp: {name:"Joel Durano", ytd_vol:12392, speed:1223, gm_ton:6434, customers_count:85, rsm_count:8, dsm_count:34}
  ⚠ Joel still in API even though Quick Wins removed his name from UI
- rsms: [8] {name, region, bu, slp_code, ytd_vol, ytd_target:0, ach_pct:0, vs_ly:0, speed:0, gm_ton, ...}
  ⚠ ytd_target=0 and ach_pct=0 across all RSMs (no budget mapping)
  ⚠ ytd_vol=15 for MART (should be much higher) — SlpCode→RSM mapping broken
- performance_matrix: {months:[4], rsms:[8], grid:[8×4]}  ← grid mostly zeros
- account_health: [8] {rsm, region, customers, silent, neg_margin}
**MISSING for UI:** L10 Scorecard data (15 weeks × measurables — needs new /api/l10), bu_region_split[], rankings (derived from rsms[])

## /api/budget (3.1KB, 1.4s)
- hero: {fy_target_mt:188266, fy_target_sales:5.97B, fy_target_gm:1.23B, ytd_actual:55928, ytd_budget:57134, achievement_pct:98}
- volume_history: [10] {year, volume_k}
- budgeted_volume: {regions:[3] {region, q1, q2, q3, q4, fy26, fy25, growth_pct, sub_rows[]}, total{q1,q2,q3,q4,fy26,fy25,growth_pct}}
- pl_summary: {months:[4], rows:[4] {label, values:[4], ytd_actual, ytd_budget, ach_pct, fy_budget}}
- achievement_by_region: [3] {region, ytd_actual, ytd_budget, ach_pct, fy_budget}
- monthly_actual_vs_budget: {months:[4], actual:[4], budget:[4]}
- gm_by_region: [3] {region, gm_actual, gm_budget, ach_pct, gm_ton}
**Has everything UI needs for Budget page.**
