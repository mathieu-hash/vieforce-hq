'use strict'
const { query } = require('./_db')
const { verifySession, verifyServiceToken } = require('./_auth')
const { serverError } = require('./lib/http')
const { getManilaToday } = require('./lib/shipping_days')
const { fmt } = require('./lib/margin_window')
const model = require('./lib/margin_preview')
const { rawMaterialImpact } = require('./lib/margin_preview_rm')
const cache = require('../lib/cache')
const EXECUTIVES = new Set(['service', 'admin', 'ceo', 'exec', 'evp', 'director'])

// All dimensions use stable codes. Aggregate at posting date for fixed window comparisons.
// Credit memo amounts are negative; document discounts are allocated before filtering.
function source(header, lines, sign) {
  return `SELECT CONVERT(char(10),T0.DocDate,23) date,
    T0.CardCode customer, MAX(T0.CardName) customer_name, T1.ItemCode sku, MAX(I.ItemName) sku_name,
    ISNULL(CONVERT(nvarchar(100),I.U_SSG),'UNKNOWN') ssg, MAX(ISNULL(SS.Name,'Unknown')) ssg_name,
    CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END region,
    ISNULL(CONVERT(nvarchar(100),C.GroupCode),'UNKNOWN') bu, MAX(ISNULL(G.GroupName,'Unknown')) bu_name,
    CONVERT(nvarchar(100),T0.SlpCode) dsm, MAX(ISNULL(S.SlpName,'Unknown')) dsm_name,
    ISNULL(CONVERT(nvarchar(100),I.U_brands),'UNKNOWN') brand, MAX(ISNULL(B.Name,'Unknown')) brand_name,
    ISNULL(T1.WhsCode,'UNKNOWN') warehouse,
    ${sign}SUM(T1.InvQty) kg, ${sign}SUM(T1.LineTotal) revenue, ${sign}SUM(T1.GrssProfit) gp,
    ${sign}SUM(ISNULL(T1.LineTotal / NULLIF(H.amount,0) * T0.DiscSum,0)) disc
    FROM ${header} T0 JOIN ${lines} T1 ON T0.DocEntry=T1.DocEntry JOIN OITM I ON I.ItemCode=T1.ItemCode
    LEFT JOIN OCRD C ON C.CardCode=T0.CardCode LEFT JOIN OCRG G ON G.GroupCode=C.GroupCode
    LEFT JOIN OSLP S ON S.SlpCode=T0.SlpCode LEFT JOIN [@OITMSSG] SS ON SS.Code=I.U_SSG
    LEFT JOIN [@OITMBRAND] B ON B.Code=I.U_brands
    CROSS APPLY (SELECT SUM(L.LineTotal) amount FROM ${lines} L WHERE L.DocEntry=T0.DocEntry) H
    WHERE T0.CANCELED='N' AND I.ItmsGrpCod=103 AND T0.DocDate>=@start AND T0.DocDate<@end
    GROUP BY T0.DocDate,T0.CardCode,T1.ItemCode,I.U_SSG,C.GroupCode,T0.SlpCode,I.U_brands,T1.WhsCode,
    CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END`
}
const SQL = source('OINV', 'INV1', '') + ' UNION ALL ' + source('ORIN', 'RIN1', '-')
const RECIPE_SQL = `SELECT P.DocEntry,P.ItemCode FG,P.Warehouse,CONVERT(char(10),P.PostDate,23) PostDate,P.CmpltQty,C.ItemCode,I.ItemName,I.ItmsGrpCod grp,C.IssuedQty
 FROM OWOR P JOIN WOR1 C ON C.DocEntry=P.DocEntry JOIN OITM F ON F.ItemCode=P.ItemCode JOIN OITM I ON I.ItemCode=C.ItemCode
 WHERE F.ItmsGrpCod=103 AND P.PostDate>=@recipeStart AND P.PostDate<@recipeEnd`
const ISSUE_SQL = `SELECT CONVERT(char(7),M.DocDate,23) ym,M.ItemCode,I.ItemName,I.ItmsGrpCod grp,M.Warehouse,SUM(M.OutQty) outq,SUM(CASE WHEN M.OutQty>0 THEN -M.TransValue ELSE 0 END) outval
 FROM OINM M JOIN OITM I ON I.ItemCode=M.ItemCode WHERE M.DocDate>=@recipeStart AND M.DocDate<@issueEnd AND I.ItmsGrpCod IN (101,102) AND M.TransType=60
 GROUP BY CONVERT(char(7),M.DocDate,23),M.ItemCode,I.ItemName,I.ItmsGrpCod,M.Warehouse`
function evidenceSql(opts, month) {
  const expressions = { customer: 'T0.CardCode', sku: 'T1.ItemCode', ssg: "ISNULL(CONVERT(nvarchar(100),I.U_SSG),'UNKNOWN')", brand: "ISNULL(CONVERT(nvarchar(100),I.U_brands),'UNKNOWN')", bu: "ISNULL(CONVERT(nvarchar(100),C.GroupCode),'UNKNOWN')", dsm: 'CONVERT(nvarchar(100),T0.SlpCode)', warehouse: "ISNULL(T1.WhsCode,'UNKNOWN')", region: "CASE WHEN T1.OcrCode2 LIKE 'L-%' THEN 'Luzon' WHEN T1.OcrCode2 LIKE 'V-%' THEN 'Visayas' WHEN T1.OcrCode2 LIKE 'M-%' THEN 'Mindanao' ELSE 'Other' END" }
  const params = { month }, predicates = Object.entries(opts.filters).map(([k, v], i) => { params['f' + i] = v; return expressions[k] + '=@f' + i }).join(' AND ')
  const part = (h, l, sign, type) => `SELECT '${type}' type,T0.DocEntry,T0.DocNum,T1.LineNum,CONVERT(char(10),T0.DocDate,23) date,T0.CardCode customer,T0.CardName customer_name,T1.ItemCode sku,I.ItemName sku_name,${sign}T1.InvQty kg,${sign}T1.LineTotal revenue,${sign}T1.GrssProfit gp,${sign}ISNULL(T1.LineTotal/NULLIF(H.amount,0)*T0.DiscSum,0) disc FROM ${h} T0 JOIN ${l} T1 ON T1.DocEntry=T0.DocEntry JOIN OITM I ON I.ItemCode=T1.ItemCode LEFT JOIN OCRD C ON C.CardCode=T0.CardCode CROSS APPLY (SELECT SUM(L.LineTotal) amount FROM ${l} L WHERE L.DocEntry=T0.DocEntry) H WHERE T0.CANCELED='N' AND I.ItmsGrpCod=103 AND CONVERT(char(7),T0.DocDate,23)=@month ${predicates ? 'AND ' + predicates : ''}`
  return { sql: 'SELECT TOP (101) * FROM (' + part('OINV', 'INV1', '', 'Invoice') + ' UNION ALL ' + part('ORIN', 'RIN1', '-', 'Credit memo') + ') E ORDER BY date DESC,DocEntry DESC,LineNum', params }
}
function createHandler(deps = {}) {
  const run = deps.query || query, authenticate = deps.authenticate || (async req => (await verifySession(req)) || (await verifyServiceToken(req)))
  const today = deps.today || (() => fmt(getManilaToday()))
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
    const session = await authenticate(req)
    if (!session) return res.status(401).json({ error: 'Sign in to VieForce HQ to open the preview.' })
    if (!EXECUTIVES.has(session.role)) return res.status(403).json({ error: 'Executive preview only. Territory access is not enabled yet.' })
    let opts
    try { opts = model.validate(req.query, today().slice(0, 7)) } catch (e) { return res.status(400).json({ error: e.message }) }
    try {
      if (req.query.evidence) {
        if (!model.monthsEnding(opts.asof).includes(req.query.evidence) || req.query.evidence < '2026-01') return res.status(400).json({ error: 'Evidence month is outside the supported history.' })
        const e = evidenceSql(opts, req.query.evidence), records = await run(e.sql, e.params)
        return res.json({ rows: records.slice(0, 100), has_more: records.length > 100, month: req.query.evidence })
      }
      const key = ['margin-preview-v1', session.id, session.role, opts.asof].join(':')
      let entry = deps.noCache ? null : cache.get(key)
      if (!entry) {
        const months = model.monthsEnding(opts.asof), start = (months[0] < '2026-01' ? '2026-01' : months[0]) + '-01'
        const [y, m] = opts.asof.split('-').map(Number)
        const next = fmt(new Date(y, m, 1)), tomorrow = new Date(today() + 'T12:00:00'); tomorrow.setDate(tomorrow.getDate() + 1)
        const end = next < fmt(tomorrow) ? next : fmt(tomorrow)
        const rows = await run(SQL, { start, end })
        entry = { rows: rows.map(r => ({ ...r, ...Object.fromEntries(model.NUMS.map(k => [k, Number(r[k]) || 0])) })), fetched_at: new Date().toISOString() }
        if (!deps.noCache) cache.set(key, entry, 300)
      }
      if (req.query.rm === '1') {
        const rmKey = key + ':rm:' + opts.base + ':' + opts.current
        let cost = deps.noCache ? null : cache.get(rmKey)
        if (!cost) {
          const [by, bm] = opts.base.split('-').map(Number), [cy, cm] = opts.current.split('-').map(Number)
          const tomorrow = new Date(today() + 'T12:00:00'); tomorrow.setDate(tomorrow.getDate() + 1)
          const next = fmt(new Date(cy, cm, 1))
          const p = { recipeStart: opts.base + '-01', recipeEnd: fmt(new Date(by, bm, 1)), issueEnd: next < fmt(tomorrow) ? next : fmt(tomorrow) }
          const [recipes, issues] = await Promise.all([run(RECIPE_SQL, p), run(ISSUE_SQL, p)])
          cost = { recipes, issues, fetched_at: new Date().toISOString() }; if (!deps.noCache) cache.set(rmKey, cost, 300)
        }
        return res.json({ ...rawMaterialImpact(entry.rows, cost.recipes, cost.issues, opts), fetched_at: cost.fetched_at })
      }
      return res.json({ ...model.build(entry.rows, opts, today()), fetched_at: entry.fetched_at })
    } catch (e) { return serverError(res, e, 'margin-preview') }
  }
}
module.exports = createHandler()
module.exports.createHandler = createHandler
module.exports.SQL = SQL
module.exports.evidenceSql = evidenceSql
