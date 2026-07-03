const { test } = require('node:test')
const assert = require('node:assert/strict')
const { regionOfWhs, regionCaseSql, baseCode } = require('../api/lib/region-map')

test('exact base plant codes map to the confirmed regions', () => {
  assert.equal(regionOfWhs('AC'), 'Luzon')
  assert.equal(regionOfWhs('BAC'), 'Visayas')      // Bacolod = Visayas (corrected)
  assert.equal(regionOfWhs('ALAE'), 'Mindanao')    // Alae = Mindanao (corrected)
  assert.equal(regionOfWhs('HOREB'), 'Visayas')
  assert.equal(regionOfWhs('SOUTH'), 'Mindanao')
})

test('sub-warehouse suffixes inherit their base plant region', () => {
  assert.equal(regionOfWhs('HOREB-IT'), 'Visayas')   // 306 MT intransit — was "Other"
  assert.equal(regionOfWhs('BAC-IT'), 'Visayas')
  assert.equal(regionOfWhs('BAC-QA'), 'Visayas')
  assert.equal(regionOfWhs('AC-PD'), 'Luzon')
  assert.equal(regionOfWhs('SOUTH-IT'), 'Mindanao')
  assert.equal(regionOfWhs('PFMIS-QA'), 'Luzon')
  assert.equal(regionOfWhs('ALAE-IT'), 'Mindanao')
})

test('genuinely region-less codes stay Other', () => {
  assert.equal(regionOfWhs('CONS'), 'Other')   // consignment
  assert.equal(regionOfWhs('ACOW'), 'Other')   // unmapped
  assert.equal(regionOfWhs(''), 'Other')
  assert.equal(regionOfWhs(null), 'Other')
})

test('baseCode strips the -suffix', () => {
  assert.equal(baseCode('HOREB-IT'), 'HOREB')
  assert.equal(baseCode('AC'), 'AC')
  assert.equal(baseCode('hbext-qa'), 'HBEXT')
})

test('regionCaseSql matches on base code via CHARINDEX/LEFT', () => {
  const sql = regionCaseSql('W', 'Warehouse')
  assert.match(sql, /CHARINDEX\('-', W\.Warehouse\)/)
  assert.match(sql, /LEFT\(W\.Warehouse/)
  assert.match(sql, /IN \('HOREB','HBEXT','BAC','ARGAO'\) THEN 'Visayas'/)
  assert.match(sql, /IN \('BUKID','SOUTH','CAG','ALAE','CCPC'\) THEN 'Mindanao'/)
})
