// Brand-family classifier for VPI finished-goods SKUs.
//
// Decision driver: OITM.ItmsGrpCod is unusable (one bucket "FINISHED GOODS"
// covering all 211 active SKUs — verified 2026-04-19). Vienovo's brand
// taxonomy lives in INV1.Dscription instead, so we classify via keyword
// match. Order in classify() matters — most-specific patterns first.
//
// Top 15 families chosen so the heatmap stays readable. Anything that falls
// to VIEPRO OTHER / OTHER is preserved in callout sums but capped at 1 row.

const FAMILIES = [
  'VIEPRO MUSCLY',     // pig grower/starter/finisher (largest line by volume)
  'VIEPROMO',          // promotional gestating line
  'VIEPRO PREMIUM',    // prestarter, lactating premium
  'VIEPRO PRIME',      // gestating/lactating prime
  'VIEPRO LAYER',      // layer feeds (poultry)
  'VIEPRO BROILER',    // broiler feeds (poultry)
  'VIEPRO PULLET',     // pullet grower
  'VIEPRO PDP',        // PDP base
  'VIEPRO 1000',       // booster crumble
  'VIEPRO 2000',       // starter big crumble
  'VIEPRO 3000',       // maintenance pellet
  'VIEPRO PROBOOST',   // probiotic supplement
  'VIEPRO POWERBOOST', // premix
  'VIETOP',            // pig premix concentrate
  'VIEPRO OTHER',      // any VIEPRO that didn't match above
  'OTHER'              // non-VIEPRO (LAYER 1 CRUMBLE WITH CYROMAZINE etc.)
]

function classify(dscription) {
  const d = String(dscription || '').toUpperCase()
  if (d.includes('MUSCLY'))      return 'VIEPRO MUSCLY'
  if (d.includes('VIEPROMO'))    return 'VIEPROMO'
  if (d.includes('POWERBOOST'))  return 'VIEPRO POWERBOOST'
  if (d.includes('PROBOOST'))    return 'VIEPRO PROBOOST'
  if (d.includes('VIETOP'))      return 'VIETOP'
  if (d.includes('LAYER'))       return 'VIEPRO LAYER'
  if (d.includes('BROILER'))     return 'VIEPRO BROILER'
  if (d.includes('PULLET'))      return 'VIEPRO PULLET'
  if (d.includes('PDP'))         return 'VIEPRO PDP'
  if (d.includes('PREMIUM'))     return 'VIEPRO PREMIUM'
  if (d.includes('PRIME'))       return 'VIEPRO PRIME'
  if (/\b3000\b/.test(d))        return 'VIEPRO 3000'
  if (/\b2000\b/.test(d))        return 'VIEPRO 2000'
  if (/\b1000\b/.test(d))        return 'VIEPRO 1000'
  if (d.includes('VIEPRO'))      return 'VIEPRO OTHER'
  return 'OTHER'
}

// Animal-segment grouping for "POULTRY (Broiler+Layer)" style aggregations
function segment(family) {
  switch (family) {
    case 'VIEPRO LAYER':
    case 'VIEPRO BROILER':
    case 'VIEPRO PULLET':
      return 'POULTRY'
    case 'VIEPRO MUSCLY':
    case 'VIEPRO PRIME':
    case 'VIEPRO PREMIUM':
    case 'VIEPROMO':
    case 'VIEPRO 1000':
    case 'VIEPRO 2000':
    case 'VIEPRO 3000':
    case 'VIEPRO PDP':
    case 'VIEPRO PROBOOST':
    case 'VIEPRO POWERBOOST':
    case 'VIETOP':
      return 'PIG'
    case 'VIEPRO OTHER':
    case 'OTHER':
    default:
      return 'OTHER'
  }
}

module.exports = { classify, segment, FAMILIES }
