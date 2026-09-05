'use strict'
const { match, total } = require('./margin_preview')
const plant = value => String(value || '').replace(/-PD$/, '')
const key = (...parts) => JSON.stringify(parts)
const badOrders = new Set([12388, 12109, 7754]) // Documented posting errors in the frozen handover.

// Diagnostic price sensitivity at a FIXED base-month recipe and sold-SKU basket.
// Not an attribution of the invoice Cost bar: production and sales occur at different times.
function rawMaterialImpact(sales, recipes, issues, opts) {
  const selected = sales.filter(r => r.date.slice(0, 7) === opts.base && match(r, opts.filters))
  const denominator = total(selected).kg
  if (denominator <= 0) return { available: false, reason: 'No positive base-month sales for this selection.' }
  const sold = new Map()
  for (const r of selected) { const k = key(r.sku, r.warehouse); const s = sold.get(k) || { sku: r.sku, name: r.sku_name, plant: r.warehouse, kg: 0 }; s.kg += r.kg; sold.set(k, s) }
  const formulas = new Map(), excluded = new Set()
  for (const r of recipes) {
    if (String(r.PostDate).slice(0, 7) !== opts.base) continue
    if (badOrders.has(Number(r.DocEntry)) || !(Number(r.CmpltQty) > 0)) { excluded.add(r.DocEntry); continue }
    const k = key(r.FG, plant(r.Warehouse))
    if (!formulas.has(k)) formulas.set(k, { orders: new Map(), ingredients: new Map() })
    const f = formulas.get(k)
    f.orders.set(r.DocEntry, Number(r.CmpltQty)) // FG denominator counted once, not once per ingredient.
    if (![101, 102].includes(Number(r.grp)) || !(Number(r.IssuedQty) > 0)) continue
    const ingredient = f.ingredients.get(r.ItemCode) || { code: r.ItemCode, name: r.ItemName, group: Number(r.grp), qty: 0 }
    ingredient.qty += Number(r.IssuedQty); f.ingredients.set(r.ItemCode, ingredient)
  }
  const prices = new Map()
  for (const r of issues) {
    if (![opts.base, opts.current].includes(r.ym) || !(Number(r.outq) > 0)) continue
    const k = key(r.ym, r.ItemCode, plant(r.Warehouse)), p = prices.get(k) || { qty: 0, value: 0 }
    p.qty += Number(r.outq); p.value += Number(r.outval) || 0; prices.set(k, p)
  }
  const ingredients = new Map(), missing = [], details = []
  let recipeKg = 0, fullyPricedKg = 0, componentQty = 0, pricedQty = 0
  for (const [k, s] of sold) {
    if (s.kg <= 0) continue
    const f = formulas.get(k)
    if (!f || !f.ingredients.size) { missing.push({ sku: s.sku, name: s.name, plant: s.plant, tons: s.kg / 1000, reason: 'No base-month recipe at this dispatch warehouse; manufacturing origin not assumed.' }); continue }
    const output = [...f.orders.values()].reduce((a, b) => a + b, 0)
    recipeKg += s.kg; let complete = true
    for (const ing of f.ingredients.values()) {
      const intensity = ing.qty / output, equivalent = intensity * s.kg
      componentQty += equivalent
      const a = prices.get(key(opts.base, ing.code, s.plant)), b = prices.get(key(opts.current, ing.code, s.plant))
      if (!a || !b || a.value < 0 || b.value < 0) { complete = false; missing.push({ sku: s.sku, name: s.name, plant: s.plant, ingredient: ing.code, tons: s.kg / 1000, reason: 'Missing or negative-valued issue price in one month; no price carried forward.' }); continue }
      pricedQty += equivalent
      const p0 = a.value / a.qty, p1 = b.value / b.qty, effect = -(p1 - p0) * equivalent / denominator * 1000
      const d = { sku: s.sku, sku_name: s.name, plant: s.plant, ingredient: ing.code, name: ing.name, group: ing.group,
        tons: s.kg / 1000, inclusion_kg_t: intensity * 1000, price0: p0, price1: p1, delta: p1 - p0,
        effect, php: effect * denominator / 1000, equivalent_kg: equivalent }
      details.push(d)
      const g = ingredients.get(ing.code) || { code: ing.code, name: ing.name, group: ing.group, effect: 0, php: 0, equivalent_kg: 0, price0_value: 0, price1_value: 0, plants: new Set() }
      g.effect += effect; g.php += d.php; g.equivalent_kg += equivalent; g.price0_value += p0 * equivalent; g.price1_value += p1 * equivalent; g.plants.add(s.plant); ingredients.set(ing.code, g)
    }
    if (complete) fullyPricedKg += s.kg
  }
  const rows = [...ingredients.values()].map(g => ({ code: g.code, name: g.name, group: g.group, effect: g.effect, php: g.php,
    inclusion_kg_t: g.equivalent_kg / denominator * 1000, price0: g.price0_value / g.equivalent_kg, price1: g.price1_value / g.equivalent_kg,
    plants: [...g.plants], details: details.filter(d => d.ingredient === g.code).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)) })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
  const rm = rows.filter(r => r.group === 101).reduce((s, r) => s + r.effect, 0), premix = rows.filter(r => r.group === 102).reduce((s, r) => s + r.effect, 0)
  return { available: rows.length > 0, reason: rows.length ? null : 'No recipe and matched issue-price coverage for this selection.', rows, missing,
    base: opts.base, current: opts.current, base_tons: denominator / 1000, rm_effect: rm, premix_effect: premix, total_effect: rm + premix,
    recipe_coverage: recipeKg / denominator, full_price_coverage: fullyPricedKg / denominator, component_price_coverage: componentQty > 0 ? pricedQty / componentQty : 0,
    excluded_orders: excluded.size, estimated: true,
    method: 'Base-month issued recipe per completed production kg × change in monthly issue price × fixed base-month sold SKU/dispatch-warehouse weights. Only same-warehouse recipes are used; origin of transferred feed is not inferred. Monthly issue prices use OINM value / quantity, not purchase list prices. Positive values benefit margin.',
    limitations: 'Production-price estimate, not a split of invoiced Cost. Base month is complete; current issue prices are month-to-date when partial. Orders are assigned by PostDate and use current completion status. Batch-to-sale lag, recipe changes, packaging, yield and subsequent revaluations are not modelled. Premixes/basemixes are not exploded, preventing double-counting of their underlying RM. Known posting-error orders excluded. Missing-price effects are unknown, not zero.' }
}
module.exports = { rawMaterialImpact }
