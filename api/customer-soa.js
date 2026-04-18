const { query } = require('./_db')
const { verifySession } = require('./_auth')
const cache = require('../lib/cache')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'Missing required parameter: id' })

  const cacheKey = `customer_soa_${id}`
  const cached = cache.get(cacheKey)
  if (cached) return res.json(cached)

  try {
    // --- Customer info: OCRD + OSLP + OCTG ---
    const infoRows = await query(`
      SELECT
        C.CardCode,
        C.CardName,
        C.Address,
        C.City,
        C.Phone1,
        C.Phone2,
        C.Cellular,
        C.E_Mail       AS email,
        C.CreditLine,
        C.frozenFor    AS frozen_for,
        S.SlpName      AS sales_rep,
        PG.PymntGroup  AS payment_terms
      FROM OCRD C
      LEFT JOIN OSLP S  ON C.SlpCode  = S.SlpCode
      LEFT JOIN OCTG PG ON C.GroupNum = PG.GroupNum
      WHERE C.CardCode = @id AND C.CardType = 'C'
    `, { id })

    if (!infoRows.length) {
      return res.status(404).json({ error: 'Customer not found' })
    }

    const info = infoRows[0]
    const accountStatus = (info.frozen_for === 'Y') ? 'Frozen' : 'Active'

    // --- Last payment from ORCT ---
    const lastPayRows = await query(`
      SELECT TOP 1
        RCT.DocDate,
        RCT.DocTotal
      FROM ORCT RCT
      WHERE RCT.CardCode = @id
        AND RCT.Canceled = 'N'
      ORDER BY RCT.DocDate DESC
    `, { id }).catch(() => [])

    const last_payment_date   = lastPayRows[0]?.DocDate   || null
    const last_payment_amount = Number(lastPayRows[0]?.DocTotal || 0)

    // --- Open invoices with aging ---
    // Note: U_DocType is a UDF that may not exist; use ObjType instead as the doc type signal.
    const invoices = await query(`
      SELECT
        I.DocDate                                    AS doc_date,
        I.DocNum                                     AS doc_num,
        I.ObjType                                    AS obj_type,
        I.NumAtCard                                  AS po_ref,
        I.DocTotal                                   AS doc_total,
        I.PaidToDate                                 AS paid_to_date,
        (I.DocTotal - I.PaidToDate)                  AS balance,
        I.DocDueDate                                 AS due_date,
        DATEDIFF(DAY, I.DocDueDate, GETDATE())       AS days_old
      FROM OINV I
      WHERE I.CardCode = @id
        AND I.CANCELED = 'N'
        AND (I.DocTotal - I.PaidToDate) > 0.01
      ORDER BY I.DocDueDate ASC
    `, { id })

    const invoiceList = invoices.map(r => {
      const days = Number(r.days_old || 0)
      let status, doc_type
      if (days <= 0)       status = 'Current'
      else if (days <= 30) status = 'Watch'
      else if (days <= 60) status = 'Overdue'
      else                 status = 'Critical'
      // ObjType 13 = Invoice, 203 = Down Payment
      if      (r.obj_type == 13)  doc_type = 'Invoice'
      else if (r.obj_type == 203) doc_type = 'Down Payment'
      else                        doc_type = 'Invoice'
      return {
        doc_date:     r.doc_date,
        doc_num:      r.doc_num,
        doc_type,
        po_ref:       r.po_ref || '',
        doc_total:    Number(r.doc_total || 0),
        paid_to_date: Number(r.paid_to_date || 0),
        balance:      Number(r.balance || 0),
        due_date:     r.due_date,
        days_old:     days,
        status
      }
    })

    // --- Aging buckets (7 buckets, oldest-first already by DATEDIFF) ---
    const aging = {
      current:  0, d1_30:   0, d31_60:  0, d61_90:  0,
      d91_120:  0, d121_365: 0, over_1y: 0
    }
    for (const inv of invoiceList) {
      const d = inv.days_old, b = inv.balance
      if      (d <= 0)    aging.current  += b
      else if (d <= 30)   aging.d1_30    += b
      else if (d <= 60)   aging.d31_60   += b
      else if (d <= 90)   aging.d61_90   += b
      else if (d <= 120)  aging.d91_120  += b
      else if (d <= 365)  aging.d121_365 += b
      else                aging.over_1y  += b
    }
    const total_ar = Object.values(aging).reduce((s, v) => s + v, 0)
    const pct = (v) => total_ar > 0 ? Math.round((v / total_ar) * 1000) / 10 : 0
    aging.current_pct  = pct(aging.current)
    aging.d1_30_pct    = pct(aging.d1_30)
    aging.d31_60_pct   = pct(aging.d31_60)
    aging.d61_90_pct   = pct(aging.d61_90)
    aging.d91_120_pct  = pct(aging.d91_120)
    aging.d121_365_pct = pct(aging.d121_365)
    aging.over_1y_pct  = pct(aging.over_1y)

    // --- DSO: trailing 90-day sales basis, same formula family as AR page ---
    const dsoRow = await query(`
      SELECT
        ISNULL(SUM(T1.LineTotal), 0) AS sales_90d
      FROM OINV T0
      INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
      WHERE T0.CardCode = @id AND T0.CANCELED = 'N'
        AND T0.DocDate >= DATEADD(DAY, -90, GETDATE())
    `, { id })
    const sales_90d = Number(dsoRow[0]?.sales_90d || 0)
    const dso = sales_90d > 0 ? Math.round(total_ar / (sales_90d / 90)) : 0

    const creditLine = Number(info.CreditLine || 0)
    const credit_used_pct = creditLine > 0
      ? Math.round((total_ar / creditLine) * 1000) / 10
      : 0

    const result = {
      customer: {
        CardCode:        info.CardCode,
        CardName:        info.CardName,
        Address:         info.Address || '',
        City:            info.City || '',
        Phone:           info.Phone1 || info.Cellular || '',
        Email:           info.email || '',
        CreditLimit:     creditLine,
        sales_rep:       info.sales_rep || '',
        payment_terms:   info.payment_terms || '',
        account_status:  accountStatus
      },
      summary: {
        total_ar:             Math.round(total_ar * 100) / 100,
        credit_used_pct,
        dso,
        last_payment_date,
        last_payment_amount,
        open_invoice_count:   invoiceList.length
      },
      aging,
      invoices: invoiceList,
      generated_at: new Date().toISOString()
    }

    cache.set(cacheKey, result, 60)
    res.json(result)
  } catch (err) {
    console.error('API error [customer-soa]:', err.message)
    res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
