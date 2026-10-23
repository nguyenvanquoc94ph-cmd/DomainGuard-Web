// DomainGuard server: web app + đồng bộ danh sách tên miền + bot Zalo (webhook).
// Chỉ cần Node.js 18 trở lên, không cần cài thêm thư viện.
//
// Biến môi trường (đặt trong Render > Environment):
//   PORT                  Render tự cấp.
//   CF_API_TOKEN          (tuỳ chọn) token Cloudflare Radar. Không có thì bỏ qua nguồn Cloudflare.
//   ZALO_BOT_TOKEN        (bật bot) Bot Token do Zalo Bot Creator gửi.
//   ZALO_WEBHOOK_SECRET   (bật bot) PHẢI trùng với Secret Token trong phần Thiết lập chung của bot Zalo.
//   ZALO_WEBHOOK_PATH     (tuỳ chọn) mặc định /zalo/webhook
//   ZALO_DEBUG=1          (tuỳ chọn) ghi nguyên dữ liệu nhận từ Zalo vào log để kiểm tra.
// Thiếu ZALO_BOT_TOKEN hoặc ZALO_WEBHOOK_SECRET thì bot tắt, web app vẫn chạy bình thường.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'domains.json');

const DG = require('./public/detector.js');

// ---------- Cấu hình ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
const userSources = readJson(path.join(CONFIG_DIR, 'sources.json'), {});
const SOURCES = {
  refreshHours: userSources.refreshHours || 24,
  port: userSources.port || 3000,
  sources: {
    cloudflareVN: Object.assign({ enabled: true, take: 2000, location: 'VN', rankingType: 'POPULAR' }, (userSources.sources || {}).cloudflareVN),
    tranco: Object.assign({ enabled: true, take: 3000, downloadRows: 6000 }, (userSources.sources || {}).tranco)
  }
};
const DEFAULT_EXCLUDE = ['googleapis.com', 'gstatic.com', 'akamai.net', 'akamaiedge.net', 'fbcdn.net', 'cloudfront.net', 'amazonaws.com', 'azureedge.net',
  'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com', 'app-measurement.com', 'apple-dns.net', 'akadns.net',
  'edgekey.net', 'edgesuite.net', 'trafficmanager.net', 'msedge.net', 'root-servers.net', 'gvt1.com', 'gvt2.com', 'ggpht.com', 'ytimg.com',
  'cdninstagram.com', 'whatsapp.net', 'tiktokcdn.com', 'byteoversea.com', 'ttlivecdn.com', 'cloudflare-dns.com', 'dns.google', 'in-addr.arpa'];
const EXCLUDE = new Set((readJson(path.join(CONFIG_DIR, 'exclude_domains.json'), {}).domains) || DEFAULT_EXCLUDE);

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function clean(d) {
  d = String(d || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(d) && !EXCLUDE.has(d) ? d : null;
}

// Thương hiệu được bảo vệ: luôn có mặt trong danh sách, kể cả khi Tranco hoặc Cloudflare lỗi.
const BUILTIN = Array.from(new Set(
  [].concat(
    (readJson(path.join(CONFIG_DIR, 'protected_brands.json'), {}).domains) || [],
    (readJson(path.join(CONFIG_DIR, 'base_domains.json'), {}).domains) || []
  ).map(clean).filter(Boolean)
));

const ENV = process.env;
const PORT = Number(ENV.PORT || SOURCES.port || 3000);
const CF_TOKEN = ENV.CF_API_TOKEN || '';
const CF_API = ENV.CF_API_BASE || 'https://api.cloudflare.com';
const TRANCO_API = ENV.TRANCO_API_BASE || 'https://tranco-list.eu';
const DNS_API = ENV.DNS_API_BASE || 'https://dns.google/resolve';
const ZALO_API = ENV.ZALO_API_BASE || 'https://bot-api.zaloplatforms.com';
const ZALO_TOKEN = ENV.ZALO_BOT_TOKEN || '';
const ZALO_SECRET = ENV.ZALO_WEBHOOK_SECRET || '';
const ZALO_PATH = ENV.ZALO_WEBHOOK_PATH || '/zalo/webhook';
const ZALO_DEBUG = ENV.ZALO_DEBUG === '1';
const ZALO_ENABLED = !!(ZALO_TOKEN && ZALO_SECRET && ZALO_SECRET.length >= 8);

// Không bao giờ để token xuất hiện trong log.
function redact(s) {
  s = String(s);
  [ZALO_TOKEN, ZALO_SECRET, CF_TOKEN].forEach(function (t) { if (t) s = s.split(t).join('***'); });
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchT = (url, opts, ms) => fetch(url, Object.assign({}, opts || {}, { signal: AbortSignal.timeout(ms || 30000) }));

// ---------- Danh sách tên miền ----------
let state = { domains: BUILTIN.slice(), counts: { cloudflareVN: 0, tranco: 0, base: BUILTIN.length }, trancoListId: null, updatedAt: null, errors: ['Chưa đồng bộ'], raw: { vn: [], tranco: [] } };
let index = DG.buildIndex(BUILTIN);

function rebuildIndex() { index = DG.buildIndex(BUILTIN.concat(state.domains)); }

function loadSaved() {
  const saved = readJson(DATA_FILE, null);
  if (saved && Array.isArray(saved.domains) && saved.domains.length) {
    state = Object.assign(state, saved, { raw: saved.raw || { vn: [], tranco: [] } });
    console.log('[sync] Đã nạp bản lưu:', state.domains.length, 'tên miền');
  }
  rebuildIndex();
}

async function loadTranco(rows) {
  const r1 = await fetchT(TRANCO_API + '/api/lists/date/latest');
  if (!r1.ok) throw new Error('HTTP ' + r1.status + ' (danh sách mới nhất)');
  const meta = await r1.json();
  if (!meta.download) throw new Error('API không trả về link tải');
  const url = String(meta.download).replace(/\/\d+$/, '/' + rows);
  const r2 = await fetchT(url, {}, 120000);
  if (!r2.ok) throw new Error('HTTP ' + r2.status + ' (tải danh sách)');
  const text = await r2.text();
  return { listId: meta.list_id || null, domains: text.split(/\r?\n/).map((l) => l.split(',')[1]).filter(Boolean).slice(0, rows) };
}

// Cloudflare trả HTTP 400 khi limit vượt mức cho phép: thử lần lượt các giá trị nhỏ hơn.
async function loadCloudflare(location, wanted, rankingType) {
  if (!CF_TOKEN) throw new Error('Thiếu biến môi trường CF_API_TOKEN');
  const tries = Array.from(new Set([wanted, 1000, 500, 100, 50])).filter((n) => n <= wanted).sort((a, b) => b - a);
  let lastErr = '';
  for (const limit of tries) {
    const qs = new URLSearchParams({ location: location, limit: String(limit), rankingType: rankingType, format: 'JSON' });
    const res = await fetchT(CF_API + '/client/v4/radar/ranking/top?' + qs, { headers: { Authorization: 'Bearer ' + CF_TOKEN } });
    if (res.status === 400) { lastErr = 'HTTP 400 với limit=' + limit + ': ' + (await res.text()).slice(0, 200); console.warn('[sync] Cloudflare', redact(lastErr)); continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const rows = (j.result && j.result.top_0) || [];
    if (limit < wanted) console.warn('[sync] Cloudflare chỉ nhận limit=' + limit + ', lấy được', rows.length, 'tên miền');
    return rows.sort((a, b) => a.rank - b.rank).map((r) => r.domain);
  }
  throw new Error(lastErr || 'HTTP 400');
}

function mergeLists(vn, tranco) {
  const out = [], seen = new Set();
  const take = (arr, n) => {
    let c = 0;
    for (const raw of arr) {
      if (c >= n) break;
      const d = clean(raw);
      if (!d || seen.has(d)) continue;
      seen.add(d); out.push(d); c++;
    }
    return c;
  };
  const base = take(BUILTIN, Infinity);
  const v = take(vn, SOURCES.sources.cloudflareVN.take);
  const t = take(tranco, SOURCES.sources.tranco.take);
  return { domains: out, counts: { cloudflareVN: v, tranco: t, base: base } };
}

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const errors = [], s = SOURCES.sources;
    let vn = state.raw.vn || [], tranco = state.raw.tranco || [], listId = state.trancoListId;   // lỗi nguồn nào thì dùng lại bản cũ của nguồn đó
    let okAny = false;
    if (s.cloudflareVN.enabled) {
      try { vn = await loadCloudflare(s.cloudflareVN.location, s.cloudflareVN.take, s.cloudflareVN.rankingType); okAny = true; }
      catch (e) { errors.push('Cloudflare Radar: ' + redact(e.message)); }
    }
    if (s.tranco.enabled) {
      try { const t = await loadTranco(s.tranco.downloadRows); tranco = t.domains; listId = t.listId; okAny = true; }
      catch (e) { errors.push('Tranco: ' + redact(e.message)); }
    }
    if (!okAny) { state.errors = errors.length ? errors : ['Không có nguồn nào được bật']; console.error('[sync] Thất bại:', state.errors.join(' | ')); return; }
    const m = mergeLists(vn, tranco);
    state = { domains: m.domains, counts: m.counts, trancoListId: listId, updatedAt: new Date().toISOString(), errors: errors, raw: { vn: vn.slice(0, 5000), tranco: tranco.slice(0, 10000) } };
    rebuildIndex();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.warn('[sync] Không ghi được bản lưu:', e.message); }
    console.log('[sync] Xong:', JSON.stringify(m.counts), errors.length ? 'Lỗi: ' + errors.join(' | ') : '');
  } catch (e) {
    console.error('[sync] Lỗi không mong đợi:', redact(e.message));
  } finally { syncing = false; }
}

// ---------- Phân tích tên miền (dùng chung logic với web) ----------
const dnsCache = new Map();
async function dnsLookup(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  let v = 'unknown';
  try {
    const r = await fetchT(DNS_API + '?name=' + encodeURIComponent(host) + '&type=SOA', { headers: { Accept: 'application/dns-json' } }, 6000);
    if (r.ok) { const j = await r.json(); v = j.Status === 0 ? 'found' : j.Status === 3 ? 'missing' : 'unknown'; }
  } catch (e) { /* unknown */ }
  if (v !== 'unknown') { if (dnsCache.size > 2000) dnsCache.clear(); dnsCache.set(host, { v: v, t: Date.now() }); }
  return v;
}

async function evaluateLink(link) {
  const r = DG.analyze(link, index);
  let lookup = null, latinName = null;
  const needLookup = r.nonAscii && r.latin !== r.host && /^[a-z0-9.-]+$/.test(r.latin) && !r.matches.some((m) => m.type === 'visual');
  if (needLookup) { latinName = DG.registrable(r.latin); lookup = await dnsLookup(latinName); }
  return { r: r, rating: DG.rate(r, lookup, latinName) };
}

// ---------- Tìm link trong tin nhắn ----------
const KNOWN_TLDS = new Set(['com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'io', 'co', 'me', 'xyz', 'top', 'online', 'site', 'shop', 'store', 'app', 'dev', 'club', 'vip',
  'live', 'click', 'link', 'icu', 'cc', 'tv', 'asia', 'mobi', 'pro', 'cloud', 'tech', 'space', 'website', 'work', 'fun', 'life', 'world', 'today', 'email', 'page', 'host', 'one', 'bank', 'finance']);
const URL_RE = /(?:https?:\/\/)[^\s<>"'\/?#]+(?:[\/?#][^\s<>"']*)?|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,63}(?::\d{1,5})?(?:[\/?#][^\s<>"']*)?/giu;

function refang(t) { return String(t).replace(/\[\.\]|\(\.\)/g, '.').replace(/\bhxxp(s?):/gi, 'http$1:'); }

function extractLinks(text, max) {
  const out = [], seen = new Set();
  const matches = refang(text).match(URL_RE) || [];
  for (let m of matches) {
    m = m.replace(/[.,;:!?)\]}'"»”’>]+$/u, '');
    if (!m) continue;
    const explicit = /^https?:\/\//i.test(m);
    if (!explicit) {
      const host = m.split(/[\/?#:]/)[0];
      const tld = host.split('.').pop().toLowerCase();
      if (!(KNOWN_TLDS.has(tld) || /^[a-z]{2}$/.test(tld) || tld.startsWith('xn--'))) continue;
    }
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(m);
    if (out.length >= (max || 5)) break;
  }
  return out;
}

function deepStrings(o, depth, out) {
  depth = depth || 0; out = out || [];
  if (depth > 4 || out.length > 50) return out;
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => deepStrings(x, depth + 1, out));
  else if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (!['from', 'chat', 'message_id', 'date'].includes(k)) deepStrings(o[k], depth + 1, out); });
  return out;
}

// ---------- Soạn câu trả lời ----------
const ICON = { red: '🚨', yellow: '⚠️', green: '✅' };
const TITLE = { red: 'NGUY CƠ CAO WEBSITE GIẢ MẠO', yellow: 'CẦN KIỂM TRA THÊM', green: 'CHƯA TÌM THẤY DẤU HIỆU BẤT THƯỜNG' };
const ADVICE = {
  red: 'Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán.',
  yellow: 'Chưa đủ dữ liệu để kết luận đây là website giả mạo.',
  green: 'Kết quả này không kết luận website an toàn hay không.'
};
// Viết [.] thay cho dấu chấm để Zalo không biến tên miền đáng ngờ thành đường link bấm được.
const defang = (s) => String(s).replace(/\./g, '[.]');
const defangDomains = (s) => String(s).replace(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, defang);

const WELCOME = '👋 Xin chào! Mình là DomainGuard.\nHãy gửi cho mình địa chỉ website hoặc đường link bạn nghi ngờ, ví dụ: amaz0n[.]com\nMình sẽ kiểm tra xem tên miền có dấu hiệu giả mạo hay không.\n\nℹ️ Mình sẽ phân tích địa chỉ website giúp bạn mà không cần phải mở trang web.';
const NON_TEXT = '🤔 Mình chưa đọc được loại tin nhắn này (ví dụ ảnh, sticker hoặc tin chuyển tiếp dạng thẻ link).\nHãy sao chép địa chỉ website rồi dán vào tin nhắn chữ nhé.';
const TOO_FAST = '⏳ Bạn gửi hơi nhanh. Vui lòng thử lại sau ít phút.';
const FOOTER = 'ℹ️ DomainGuard chỉ phân tích hình thức tên miền, không mở trang web.';

function formatItem(item, many) {
  const r = item.r, level = item.rating.level;
  const lines = [ICON[level] + ' ' + TITLE[level], 'Tên miền: ' + defang(r.host)];
  if (r.nonAscii) lines.push('Dạng ASCII: ' + defang(r.ascii));
  item.rating.reasons.slice(0, many ? 2 : 3).forEach((t) => lines.push('• ' + defangDomains(t)));
  lines.push(ADVICE[level]);
  return lines.join('\n');
}

function buildReply(items, failed) {
  const parts = items.map((it) => formatItem(it, items.length > 1));
  failed.forEach((f) => parts.push('❔ Không đọc được địa chỉ: ' + defang(f.slice(0, 80))));
  let text = parts.join('\n\n') + '\n\n' + FOOTER;
  if (text.length > 2000) text = Array.from(text).slice(0, 1995).join('') + '…';
  return text;
}

// ---------- Bot Zalo ----------
async function zaloSend(chatId, text) {
  const url = ZALO_API + '/bot' + ZALO_TOKEN + '/sendMessage';
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text }) }, 15000);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) console.error('[zalo] sendMessage lỗi', res.status, redact(JSON.stringify(j).slice(0, 200)));
      return j;
    } catch (e) {
      if (i === 1) console.error('[zalo] sendMessage thất bại:', redact(e.message)); else await sleep(1000);
    }
  }
}

const seenMsg = new Map();   // chống xử lý 2 lần khi Zalo gửi lại webhook
const rate = new Map();      // giới hạn số tin mỗi người
const RATE_MAX = 8, RATE_WINDOW = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  seenMsg.forEach((t, k) => { if (now - t > 10 * 60 * 1000) seenMsg.delete(k); });
  rate.forEach((e, k) => { if (now - e.start > RATE_WINDOW) rate.delete(k); });
}, 5 * 60 * 1000).unref();

function allow(chatId) {
  const now = Date.now();
  let e = rate.get(chatId);
  if (!e || now - e.start > RATE_WINDOW) { e = { start: now, n: 0, warned: false }; rate.set(chatId, e); }
  e.n++;
  if (e.n <= RATE_MAX) return 'ok';
  if (!e.warned) { e.warned = true; return 'warn'; }
  return 'drop';
}

function extractEvents(b) {
  if (!b || typeof b !== 'object') return [];
  if (Array.isArray(b)) return b.flatMap(extractEvents);
  if (b.result !== undefined && !b.event_name) return extractEvents(b.result);
  return (b.event_name || b.message) ? [b] : [];
}

async function processZaloEvent(ev) {
  const m = ev.message;
  if (!m || typeof m !== 'object') return;
  const name = String(ev.event_name || '');
  const from = m.from || {};
  if (from.is_bot) return;
  const chatId = (m.chat && m.chat.id) || from.id;
  if (!chatId) { console.warn('[zalo] Sự kiện không có chat id:', name); return; }
  const type = m.chat && m.chat.chat_type ? String(m.chat.chat_type).toUpperCase() : 'PRIVATE';
  const isPrivate = type === 'PRIVATE';
  console.log('[zalo] sự kiện', name, isPrivate ? '(riêng tư)' : '(nhóm)');
  if (ZALO_DEBUG) console.log('[zalo][debug]', redact(JSON.stringify(ev)));

  if (m.message_id) {
    const key = chatId + ':' + m.message_id;
    if (seenMsg.has(key)) return;
    seenMsg.set(key, Date.now());
  }
  const gate = allow(String(chatId));
  if (gate === 'drop') return;
  if (gate === 'warn') { if (isPrivate) await zaloSend(chatId, TOO_FAST); return; }

  const text = typeof m.text === 'string' ? m.text : '';
  let links = extractLinks(text);
  // Tin chuyển tiếp dạng thẻ link có thể không có text: thử tìm link trong các trường còn lại. Chưa kiểm chứng với Zalo thật.
  if (!links.length && /unsupported/i.test(name)) links = extractLinks(deepStrings(m).join(' '));

  if (!links.length) {
    if (!isPrivate) return;   // trong nhóm chỉ trả lời khi có link
    await zaloSend(chatId, text ? WELCOME : NON_TEXT);
    return;
  }
  const items = [], failed = [];
  await Promise.all(links.map(async (l, i) => {
    try { items[i] = await evaluateLink(l); } catch (e) { failed.push(l); }
  }));
  await zaloSend(chatId, buildReply(items.filter(Boolean), failed));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(Object.assign(new Error('Quá lớn'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function handleZalo(req, res) {
  if (!safeEqual(req.headers['x-bot-api-secret-token'] || '', ZALO_SECRET)) return sendJson(res, 401, { ok: false });
  let raw;
  try { raw = await readBody(req, 256 * 1024); } catch (e) { return sendJson(res, e.status || 400, { ok: false }, { Connection: 'close' }); }
  let body;
  try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false }); }
  sendJson(res, 200, { ok: true });   // trả lời ngay, xử lý (có thể tra DNS vài giây) sau
  extractEvents(body).forEach((ev) => processZaloEvent(ev).catch((e) => console.error('[zalo] Lỗi xử lý:', redact(e.message))));
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function sendJson(res, code, obj, extra) {
  if (res.headersSent) return;
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, BASE_HEADERS, extra || {}));
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, BASE_HEADERS));
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendText(res, 400, 'Yêu cầu không hợp lệ'); }
  if (rel.indexOf('\0') !== -1) return sendText(res, 400, 'Yêu cầu không hợp lệ');
  if (rel === '/') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Không tìm thấy');
  let st;
  try { st = await fs.promises.stat(target); } catch (e) { return sendText(res, 404, 'Không tìm thấy'); }
  if (!st.isFile()) return sendText(res, 404, 'Không tìm thấy');
  res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' }, BASE_HEADERS));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const zaloPath = ZALO_PATH.replace(/\/+$/, '');
    if (p === '/healthz') return sendText(res, 200, 'ok');
    if (p === '/api/domains' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { domains: state.domains, counts: state.counts, trancoListId: state.trancoListId, updatedAt: state.updatedAt, errors: state.errors });
    }
    if (p.replace(/\/+$/, '') === zaloPath) {
      if (req.method !== 'POST') return sendText(res, 405, 'Method Not Allowed');
      if (!ZALO_ENABLED) return sendJson(res, 503, { ok: false, error: 'Bot Zalo chưa được bật' });
      return await handleZalo(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error('[http] Lỗi:', redact(e.message));
    if (!res.headersSent) sendText(res, 500, 'Lỗi máy chủ'); else res.destroy();
  }
});

process.on('unhandledRejection', (e) => console.error('[lỗi] unhandledRejection:', redact(e && e.message ? e.message : e)));

if (require.main === module) {
  loadSaved();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('DomainGuard chạy tại cổng ' + PORT);
    console.log('[web] Thương hiệu tích hợp sẵn:', BUILTIN.length, '| Cloudflare:', CF_TOKEN ? 'có token' : 'không có token');
    if (ZALO_ENABLED) console.log('[zalo] Bot BẬT, webhook tại ' + ZALO_PATH);
    else console.log('[zalo] Bot TẮT' + (ZALO_TOKEN && !ZALO_SECRET ? ' (có ZALO_BOT_TOKEN nhưng thiếu ZALO_WEBHOOK_SECRET)' : ZALO_SECRET && ZALO_SECRET.length < 8 ? ' (ZALO_WEBHOOK_SECRET phải từ 8 ký tự)' : ''));
  });
  sync();
  setInterval(sync, SOURCES.refreshHours * 3600 * 1000);
  const stop = () => { console.log('Đang tắt...'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { extractLinks, refang, defangDomains, buildReply, extractEvents };
