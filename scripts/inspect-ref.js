#!/usr/bin/env node
const XLSX = require('xlsx');
const path = require('path');
const wb = XLSX.readFile(path.join(__dirname,'..','docs','reference','Itemized_Sales_Forecst_Per_District_2025_v2.xlsx'));
const ws = wb.Sheets['CEBU NORTH'];
const range = XLSX.utils.decode_range(ws['!ref']);
console.log('range:', ws['!ref']);
for (let r = 0; r <= Math.min(range.e.r, 290); r++){
  const a = ws[XLSX.utils.encode_cell({r,c:0})];
  const b = ws[XLSX.utils.encode_cell({r,c:1})];
  const c = ws[XLSX.utils.encode_cell({r,c:2})];
  const d = ws[XLSX.utils.encode_cell({r,c:3})];
  const ay = a ? a.v : '';
  const by = b ? b.v : '';
  const cy = c ? c.v : '';
  const dy = d ? d.v : '';
  if (by || cy) console.log((r+1).toString().padStart(3)+' | A:'+String(ay).slice(0,15).padEnd(15)+' | B:'+String(by).slice(0,14).padEnd(14)+' | C:'+String(cy).slice(0,50).padEnd(50)+' | D:'+dy);
}
