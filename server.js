// DomainGuard server: đồng bộ danh sách tên miền và phục vụ website.
// Yêu cầu: Node.js 18+ (có sẵn fetch). Không cần cài thêm thư viện.
// Biến môi trường: CF_API_TOKEN (bắt buộc cho Cloudflare Radar), PORT (tuỳ chọn).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const CONFIG = readJson('config/sources.json');
const EXCLUDE = new Set(readJson('config/exclude_domains.json').domains);
const BASE = readJson('config/base_domains.json').domains;
const DATA_FILE = path.join(ROOT, 'data', 'domains.json');
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function clean(d) {
  d = String(d || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(d) && !EXCLUDE.has(d) ? d : null;
}

async function fetchTimeout(url, opts = {}, ms = 60000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res;
}

// Tranco: lấy ID danh sách mới nhất, tải N dòng đầu (CSV: rank,domain).
async function loadTranco(rows) {
  const meta = await (await fetchTimeout('https://tranco-list.eu/api/lists/date/latest')).json();
  let url = meta.download;
  if (!url) throw new Error('Tranco API không trả về link tải');
  url = url.replace(/\/\d+$/, '/' + rows);
  const text = await (await fetchTimeout(url, {}, 120000)).text();
  const list = text.split(/\r?\n/).map((l) => l.split(',')[1]).filter(Boolean).slice(0, rows);
  return { listId: meta.list_id || null, domains: list };
}

// Cloudflare Radar: top tên miền phổ biến theo quốc gia (cần API token).
async function loadCloudflare(location, limit, rankingType) {
  const token = process.env.CF_API_TOKEN;
  if (!token) throw new Error('Thiếu biến môi trường CF_API_TOKEN');
  const qs = new URLSearchParams({ location, limit: String(limit), rankingType, format: 'JSON' });
  const res = await fetchTimeout('https://api.cloudflare.com/client/v4/radar/ranking/top?' + qs, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const j = await res.json();
  const rows = (j.result && j.result.top_0) || [];
  return rows.sort((a, b) => a.rank - b.rank).map((r) => r.domain);
}

// Gộp: lấy đủ 2.000 tên miền Việt Nam, sau đó lấy 3.000 tên miền Tranco không trùng.
function merge(vn, tranco) {
  const out = [], seen = new Set();
  const take = (arr, n, tag) => {
    let added = 0;
    for (const raw of arr) {
      if (added >= n) break;
      const d = clean(raw);
      if (!d || seen.has(d)) continue;
      seen.add(d); out.push(d); added++;
    }
    return added;
  };
  const vnCount = take(vn, CONFIG.sources.cloudflareVN.take, 'vn');
  const trancoCount = take(tranco, CONFIG.sources.tranco.take, 'tranco');
  const baseCount = take(BASE, BASE.length, 'base');
  return { domains: out, counts: { cloudflareVN: vnCount, tranco: trancoCount, base: baseCount } };
}

let state = { domains: BASE.slice(), updatedAt: null, counts: { cloudflareVN: 0, tranco: 0, base: BASE.length }, errors: ['Chưa đồng bộ'] };
if (fs.existsSync(DATA_FILE)) {
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); console.log('Đã nạp bản lưu', state.domains.length, 'tên miền'); } catch (e) { /* giữ BASE */ }
}

async function sync() {
  const errors = [];
  let vn = [], tranco = [], trancoListId = null;
  const s = CONFIG.sources;
  if (s.cloudflareVN.enabled) {
    try { vn = await loadCloudflare(s.cloudflareVN.location, s.cloudflareVN.take, s.cloudflareVN.rankingType); }
    catch (e) { errors.push('Cloudflare Radar: ' + e.message); }
  }
  if (s.tranco.enabled) {
    try { const t = await loadTranco(s.tranco.downloadRows); tranco = t.domains; trancoListId = t.listId; }
    catch (e) { errors.push('Tranco: ' + e.message); }
  }
  if (!vn.length && !tranco.length) {
    // Không ghi đè bản lưu tốt bằng dữ liệu rỗng.
    state.errors = errors; console.error('Đồng bộ thất bại:', errors.join(' | '));
    return;
  }
  const m = merge(vn, tranco);
  state = { domains: m.domains, counts: m.counts, trancoListId, updatedAt: new Date().toISOString(), errors };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  console.log('Đồng bộ xong:', JSON.stringify(m.counts), errors.length ? 'Lỗi: ' + errors.join(' | ') : '');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/domains') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }
  const file = path.normalize(path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  const port = Number(process.env.PORT || CONFIG.port || 3000);
  server.listen(port, () => console.log('DomainGuard chạy tại http://localhost:' + port));
  sync();
  setInterval(sync, CONFIG.refreshHours * 3600 * 1000);
}
module.exports = { merge, clean };
