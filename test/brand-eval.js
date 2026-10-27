// Đo chất lượng trên dữ liệu thật (sau khi server đã đồng bộ ít nhất 1 lần).
//   node test/brand-eval.js                 -> dùng data/domains.json và data/blacklist.json
//   node test/brand-eval.js top-1m.csv      -> thêm danh sách tên miền phổ biến (CSV "hạng,tên miền" hoặc mỗi dòng 1 tên miền)
// Đo đúng như người dùng thấy (DG.decide), KHÔNG coi tên miền là "phổ biến", để thấy luật thương hiệu tự nó báo nhầm bao nhiêu.
// Điều kiện đề xuất để chạy chế độ 'warn': báo nhầm (vàng/đỏ) < 0,5%.
'use strict';
const fs = require('fs'), path = require('path');
const DG = require('../public/detector.js');
const cr = DG.compileBrandRules(require('../public/brand_rules.json'));
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const EMPTY = DG.buildIndex([]);
const verdict = (d) => { try { return DG.decide({ r: DG.analyze(d, EMPTY, cr), rules: cr, mode: 'warn' }); } catch (e) { return null; } };

const popular = new Set();
const dom = read(path.join(DATA, 'domains.json'));
if (dom) [].concat(dom.domains || [], (dom.raw && dom.raw.tranco) || [], (dom.raw && dom.raw.vn) || []).forEach((d) => popular.add(String(d).toLowerCase()));
if (process.argv[2]) fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).forEach((l) => { const d = (l.includes(',') ? l.split(',')[1] : l).trim().toLowerCase(); if (d) popular.add(d); });

const fp = [], notes = [];
popular.forEach((d) => {
  const v = verdict(d); if (!v || !v.brand) return;
  (v.brandLevel === 'note' ? notes : fp).push([d, v.brand.brand, v.brand.matchType, v.brand.strength, v.brand.keyword || '', v.level]);
});
const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00') + '%';
console.log('== BÁO NHẦM trên tên miền phổ biến (giả định chúng hợp pháp) ==');
console.log('Tổng:', popular.size, '| bị cảnh báo vàng/đỏ:', fp.length, '(' + pct(fp.length, popular.size) + ') | chỉ ghi chú:', notes.length);
const byBrand = {};
fp.forEach((x) => { byBrand[x[1]] = (byBrand[x[1]] || 0) + 1; });
console.log('Theo thương hiệu:', Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => x[0] + '=' + x[1]).join(', ') || '(không có)');
fp.slice(0, 30).forEach((x) => console.log('  ', x.join(' | ')));
try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'brand-eval-false-positives.csv'), 'domain,brand,matchType,strength,keyword,level\n' + fp.map((x) => x.join(',')).join('\n')); } catch (e) { /* bỏ qua */ }

const bl = read(path.join(DATA, 'blacklist.json'));
const bad = new Set();
if (bl && bl.feeds) Object.values(bl.feeds).forEach((f) => (f.hosts || []).forEach((h) => bad.add(h)));
let hit = 0, strong = 0; const ex = [];
bad.forEach((h) => { const r = DG.detectBrandAbuse(h, cr); if (r) { hit++; if (r.strength === 'strong') strong++; if (ex.length < 15) ex.push(h + ' -> ' + r.brand + ' (' + r.strength + ')'); } });
console.log('\n== PHÁT HIỆN thương hiệu trên danh sách đen ==');
console.log('Tổng host:', bad.size, '| có dấu hiệu thương hiệu:', hit, '(' + pct(hit, bad.size) + ') | trong đó mạnh:', strong);
ex.forEach((x) => console.log('  ', x));
const ok = popular.size && fp.length / popular.size < 0.005;
console.log('\nKết luận:', !popular.size ? 'thiếu dữ liệu tên miền phổ biến.' : ok ? '✅ Báo nhầm < 0,5% – đạt điều kiện chạy chế độ warn.' : '⚠️ Báo nhầm ≥ 0,5% – xem file CSV, bổ sung official/strict/stopwords.');
