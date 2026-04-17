#!/usr/bin/env node
// Parse the reference Itemized Sales Forecast workbook and emit:
//   api/data/product_hierarchy.json  — group/sub_group/form/order for every SKU row
//   api/data/district_managers.json  — sheet name → manager (R1 col A)
//   api/data/district_list.json      — ordered list of sheet names + section groupings
//
// Run: node scripts/parse-itemized-ref.js

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const REF = path.join(__dirname, '..', 'docs', 'reference',
  'Itemized_Sales_Forecst_Per_District_2025_v2.xlsx');
const OUT_DIR = path.join(__dirname, '..', 'api', 'data');
fs.mkdirSync(OUT_DIR, { recursive: true });

const wb = XLSX.readFile(REF);
console.log('Loaded:', wb.SheetNames.length, 'sheets');

// ─── Section classifier ─────────────────────────────────────────
function classifySheet(name){
  const n = name.toUpperCase();
  if (/^TOTAL /.test(n)) return 'TOTAL';
  if (/^KA/.test(n))      return 'KEY_ACCOUNTS';
  if (/^PET /.test(n))    return 'PET';
  if (n === 'CSD')        return 'OTHER';
  if (n === 'MATHIEU')    return 'OTHER';
  return 'DISTRICT';
}

// ─── District manager = sheet's R1 col A ─────────────────────────
const managers = {};
const sections = { DISTRICT:[], KEY_ACCOUNTS:[], PET:[], OTHER:[], TOTAL:[] };

wb.SheetNames.forEach(name => {
  const ws = wb.Sheets[name];
  const mgr = (ws['A1'] && ws['A1'].v) ? String(ws['A1'].v).trim() : null;
  managers[name] = mgr;
  sections[classifySheet(name)].push(name);
});

// ─── Product hierarchy from a reference sheet (CEBU NORTH has the full list) ───
const REF_SHEET = wb.SheetNames.includes('CEBU NORTH') ? 'CEBU NORTH' : wb.SheetNames[0];
console.log('Reference sheet for hierarchy:', REF_SHEET);

const ws = wb.Sheets[REF_SHEET];
const range = XLSX.utils.decode_range(ws['!ref']);
const rows = [];
for (let r = range.s.r; r <= range.e.r; r++){
  const row = [];
  for (let c = 0; c <= 5; c++){
    const addr = XLSX.utils.encode_cell({r, c});
    row.push(ws[addr] ? ws[addr].v : null);
  }
  rows.push(row);
}

// Header detection rules
// - "Group header" = col C has a label, col B (ItemCode) empty, looks like UPPERCASE category
// - "SKU row" = col B has an ItemCode (vpi... or similar alphanumeric)
// - "Form summary" = col C matches one of Pellets/Crumbles/Mash/Extruded/Grains/Ready Mix/Wet Products
// - "Grand total" = col C === 'TOTAL'

const FORM_NAMES = ['PELLETS','CRUMBLES','MASH','EXTRUDED','GRAINS','READY MIX','WET PRODUCTS'];
const TOP_LEVEL = new Set([
  'VIEPRO','VIEPRO PRIME','VIEPRO PROMO','VIETOP',
  'POULTRY','OTHERS','PROBOOST','PRIVATE LABEL','AQUA','PET FOOD'
]);

const hierarchy = [];
let currentGroup = null;
let currentSubGroup = null;
let inFormSummary = false;
let order = 0;
const seenTopLevel = new Set();

function isSkuCode(v){
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return /^vpi\d+/.test(s);
}
function isHeaderLabel(c){
  if (!c) return false;
  const s = String(c).trim();
  if (!s) return false;
  if (FORM_NAMES.includes(s.toUpperCase())) return false;
  if (s.toUpperCase() === 'TOTAL') return false;
  // Header labels are uppercase-ish and have no lowercase characters
  return /^[A-Z][A-Z\- +&/0-9]*$/.test(s.toUpperCase()) && s.length > 2;
}

// Main walk
for (let i = 0; i < rows.length; i++){
  const [a, b, c, d] = rows[i];
  if (!c && !b) continue;

  const cStr = c ? String(c).trim() : '';
  const cU   = cStr.toUpperCase();

  // Grand total
  if (cU === 'TOTAL' && !isSkuCode(b)){
    hierarchy.push({ kind:'grand_total', label:'TOTAL', row_in_ref: i+1 });
    continue;
  }

  // Form summary row
  if (FORM_NAMES.includes(cU) && !isSkuCode(b)){
    inFormSummary = true;
    hierarchy.push({ kind:'form_summary', label:cStr, row_in_ref: i+1 });
    continue;
  }

  // SKU row — B must start with "vpi"
  if (isSkuCode(b)){
    hierarchy.push({
      kind: 'sku',
      item_code: String(b).trim(),
      name: cStr || null,
      bag_size_kg: d != null ? Number(d) : null,
      group: currentGroup,
      sub_group: currentSubGroup,
      row_in_ref: i+1
    });
    continue;
  }

  // Non-SKU row with an uppercase label in C = group or sub-group header
  if (isHeaderLabel(c) && !inFormSummary){
    if (TOP_LEVEL.has(cU) && !seenTopLevel.has(cU)){
      seenTopLevel.add(cU);
      order++;
      currentGroup = cStr;
      currentSubGroup = null;
      hierarchy.push({ kind:'group_header', group: cStr, order, row_in_ref: i+1 });
    } else {
      // Anything else under current top-level = sub-group
      currentSubGroup = cStr;
      hierarchy.push({ kind:'sub_group_header', group: currentGroup, sub_group: cStr, row_in_ref: i+1 });
    }
    continue;
  }
}

const skus = hierarchy.filter(x=>x.kind==='sku');
const groups = hierarchy.filter(x=>x.kind==='group_header').map(x=>x.group);
const subGroups = hierarchy.filter(x=>x.kind==='sub_group_header');

console.log('Top-level groups:', groups);
console.log('Sub-groups:', subGroups.map(s=>s.group+' > '+s.sub_group));
console.log('Total SKUs:', skus.length);

// ─── Build product_hierarchy.json — indexed by item_code ────────
const byItem = {};
skus.forEach(s => {
  byItem[s.item_code] = {
    item_code: s.item_code,
    name: s.name,
    bag_size_kg: s.bag_size_kg,
    group: s.group,
    sub_group: s.sub_group
  };
});

// Parent→children structure for the UI
const structureMap = {};
const seenGroups = [];
hierarchy.forEach(x => {
  if (x.kind === 'group_header'){
    if (!structureMap[x.group]){
      structureMap[x.group] = { name: x.group, order: x.order, skus: [], sub_groups: [] };
      seenGroups.push(x.group);
    }
  } else if (x.kind === 'sub_group_header'){
    if (!structureMap[x.group]) return;
    if (!structureMap[x.group].sub_groups.find(sg => sg.name === x.sub_group)){
      structureMap[x.group].sub_groups.push({ name: x.sub_group, skus: [] });
    }
  } else if (x.kind === 'sku'){
    if (!x.group || !structureMap[x.group]) return;
    const g = structureMap[x.group];
    if (x.sub_group){
      const sg = g.sub_groups.find(s => s.name === x.sub_group);
      if (sg) sg.skus.push(x.item_code);
    } else {
      g.skus.push(x.item_code);
    }
  }
});
const structure = seenGroups.map(name => structureMap[name]);
// Flag is_parent for rendering
structure.forEach(g => { if (g.sub_groups.length) g.is_parent = true; });

// ─── Write files ─────────────────────────────────────────────────
fs.writeFileSync(
  path.join(OUT_DIR, 'product_hierarchy.json'),
  JSON.stringify({ skus: byItem, structure }, null, 2)
);
fs.writeFileSync(
  path.join(OUT_DIR, 'district_managers.json'),
  JSON.stringify(managers, null, 2)
);
fs.writeFileSync(
  path.join(OUT_DIR, 'district_list.json'),
  JSON.stringify(sections, null, 2)
);

console.log('\nWrote:');
console.log('  api/data/product_hierarchy.json  (' + Object.keys(byItem).length + ' SKUs, ' + structure.length + ' groups)');
console.log('  api/data/district_managers.json  (' + Object.keys(managers).length + ' sheets)');
console.log('  api/data/district_list.json      (sections: ' + Object.entries(sections).map(([k,v])=>k+'='+v.length).join(', ') + ')');
