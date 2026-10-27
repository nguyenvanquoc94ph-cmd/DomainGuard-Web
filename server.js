// DomainGuard server v0.8: web app + đồng bộ danh sách tên miền + danh sách đen + phát hiện lợi dụng thương hiệu + bot Zalo (webhook).
// Chỉ cần Node.js 18 trở lên, không cần cài thêm thư viện.
//
// Biến môi trường (đặt trong Render > Environment):
//   PORT                  Render tự cấp.
//   CF_API_TOKEN          (tuỳ chọn) token Cloudflare Radar. Không có thì bỏ qua nguồn Cloudflare.
//   ZALO_BOT_TOKEN        (bật bot) Bot Token do Zalo Bot Creator gửi.
//   ZALO_WEBHOOK_SECRET   (bật bot) PHẢI trùng với Secret Token trong phần Thiết lập chung của bot Zalo.
//   ZALO_WEBHOOK_PATH     (tuỳ chọn) mặc định /zalo/webhook
//   FIREBASE_DATABASE_URL  (tuỳ chọn) URL Realtime Database để bot Zalo đọc số báo cáo cộng đồng.
//   RDAP_BOOTSTRAP_URL / RDAP_API_BASE (tuỳ chọn) nguồn tra cứu thông tin đăng ký tên miền (mặc định: danh sách IANA).
//   URLHAUS_AUTH_KEY      (tuỳ chọn, miễn phí) Auth-Key abuse.ch để bật danh sách đen URLhaus (mã độc).
//   BRAND_MODE            (tuỳ chọn) 'warn' | 'log' - ghi đè "mode" trong public/brand_rules.json, áp dụng cho CẢ web và bot.
//   API_RATE_LIMIT        (tuỳ chọn) số lần gọi /api/* mỗi phút cho mỗi IP (mặc định 60).
//   ZALO_DEBUG=1          (tuỳ chọn) ghi nguyên dữ liệu nhận từ Zalo vào log để kiểm tra.
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
const { createBlacklist, SHARED_HOSTS } = require('./blacklist.js');

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
  },
  blacklist: Object.assign({ refreshHours: 6, maxPerFeed: 300000, feeds: {} }, userSources.blacklist || {})
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
// Bộ luật thương hiệu: NGUỒN DUY NHẤT cho tên miền chính thức, dùng chung với trình duyệt (public/brand_rules.json).
const BRAND_RAW = readJson(path.join(PUBLIC_DIR, 'brand_rules.json'), null);
if (BRAND_RAW && /^(warn|log)$/.test(process.env.BRAND_MODE || '')) BRAND_RAW.mode = process.env.BRAND_MODE;
const BRAND = DG.compileBrandRules(BRAND_RAW);
const BRAND_OFFICIAL = BRAND ? Array.from(BRAND.official.keys()) : [];
// Danh sách bảo vệ = protected_brands.json + base_domains.json + tên miền chính thức trong brand_rules.json.
const BUILTIN = Array.from(new Set(
  [].concat(
    (readJson(path.join(CONFIG_DIR, 'protected_brands.json'), {}).domains) || [],
    (readJson(path.join(CONFIG_DIR, 'base_domains.json'), {}).domains) || [],
    BRAND_OFFICIAL
  ).map(clean).filter(Boolean)
));
const BUILTIN_SET = new Set(BUILTIN);

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
const FIREBASE_DATABASE_URL = String(ENV.FIREBASE_DATABASE_URL || '').replace(/\/+$/, '');
const ZALO_ENABLED = !!(ZALO_TOKEN && ZALO_SECRET && ZALO_SECRET.length >= 8);
const URLHAUS_KEY = ENV.URLHAUS_AUTH_KEY || '';

function redact(s) {
  s = String(s);
  [ZALO_TOKEN, ZALO_SECRET, CF_TOKEN, URLHAUS_KEY].forEach(function (t) { if (t) s = s.split(t).join('***'); });
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
    let vn = state.raw.vn || [], tranco = state.raw.tranco || [], listId = state.trancoListId;
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

// ---------- Danh sách đen ----------
// Chính thức: chỉ danh sách bảo vệ (không gồm Tranco/Cloudflare). Tên miền con trên dịch vụ dùng chung không được tính.
const SHARED_ALL = new Set([...SHARED_HOSTS, ...(BRAND ? BRAND.shared : [])]);
function suffixIn(host, set, skipShared) {
  if (set.has(host)) return true;
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const s = parts.slice(i).join('.');
    if (skipShared && SHARED_ALL.has(s)) return false;
    if (set.has(s)) return true;
  }
  return false;
}
const isOfficialHost = (host) => suffixIn(host, BUILTIN_SET, true);
const isPopularHost = (host) => suffixIn(host, index.set, true);

// ---------- Allowlist (quản trị viên gỡ cảnh báo) ----------
// Nguồn: config/allowlist.json (cần deploy) + Firebase allowlist/<ten-mien-thay-dau-cham-bang-dau-phay> = true (không cần deploy).
let allowSet = new Set();
async function refreshAllowlist() {
  const out = new Set((readJson(path.join(CONFIG_DIR, 'allowlist.json'), {}).domains || []).map(clean).filter(Boolean));
  if (FIREBASE_DATABASE_URL) {
    try {
      const res = await fetchT(FIREBASE_DATABASE_URL + '/allowlist.json', {}, 8000);
      if (res.ok) Object.keys((await res.json()) || {}).forEach((k) => { const d = clean(k.replace(/,/g, '.')); if (d) out.add(d); });
    } catch (e) { /* giữ danh sách cũ của Firebase */ allowSet.forEach((d) => out.add(d)); }
  }
  allowSet = out;
}
const BL = createBlacklist({
  dataDir: DATA_DIR, fetchT: fetchT, redact: redact, registrable: DG.registrable, isOfficial: isOfficialHost, isPopular: isPopularHost,
  refreshHours: SOURCES.blacklist.refreshHours, maxPerFeed: SOURCES.blacklist.maxPerFeed, enabled: SOURCES.blacklist.feeds,
  userAgent: 'DomainGuard/0.8 (+https://domainguard-web.onrender.com)'
});

// ---------- DNS ----------
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

// ---------- RDAP ----------
const RDAP_BOOTSTRAP = ENV.RDAP_BOOTSTRAP_URL || 'https://data.iana.org/rdap/dns.json';
const RDAP_FALLBACK = ENV.RDAP_API_BASE || 'https://rdap.org/';
const RDAP_UA = 'DomainGuard/0.8 (+https://domainguard-web.onrender.com)';
let rdapBoot = { t: 0, map: null };
const rdapCache = new Map();
async function rdapServers(tld) {
  if (!rdapBoot.map || Date.now() - rdapBoot.t > 24 * 3600 * 1000) {
    try {
      const r = await fetchT(RDAP_BOOTSTRAP, { headers: { 'User-Agent': RDAP_UA, Accept: 'application/json' } }, 8000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), map = new Map();
      for (const svc of j.services || []) for (const t of svc[0] || []) map.set(String(t).toLowerCase(), svc[1] || []);
      if (map.size) rdapBoot = { t: Date.now(), map: map };
    } catch (e) { console.warn('[rdap] không tải được danh sách IANA:', e.message); }
  }
  return rdapBoot.map ? (rdapBoot.map.get(tld) || null) : undefined;
}
function rdapName(entity) {
  const rows = entity && entity.vcardArray && Array.isArray(entity.vcardArray[1]) ? entity.vcardArray[1] : [];
  for (const key of ['org', 'fn']) {
    const row = rows.find((x) => Array.isArray(x) && x[0] === key && typeof x[3] === 'string' && x[3].trim());
    if (row && !/redacted|privacy|proxy|withheld|not disclosed|data protected/i.test(row[3])) return row[3].trim().slice(0, 160);
  }
  return null;
}
const rdapEvent = (j, names) => { const e = (j.events || []).find((x) => names.includes(String(x.eventAction || '').toLowerCase())); return e && e.eventDate ? e.eventDate : null; };
function findEntity(list, role) {
  for (const e of list || []) { if ((e.roles || []).includes(role)) return e; const i = findEntity(e.entities, role); if (i) return i; }
  return null;
}
async function rdapFetch(base, domain) {
  const url = base.replace(/\/+$/, '') + '/domain/' + encodeURIComponent(domain);
  const res = await fetchT(url, { headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': RDAP_UA }, redirect: 'follow' }, 9000);
  return { res: res, url: url };
}
async function domainInfo(domain) {
  const hit = rdapCache.get(domain);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.v;
  const tld = domain.split('.').pop(), servers = await rdapServers(tld);
  if (servers === null) throw Object.assign(new Error('Đuôi .' + tld + ' chưa cung cấp dữ liệu đăng ký công khai qua RDAP.'), { status: 404 });
  const bases = (servers && servers.length ? servers.slice().sort((a, b) => /^https:/.test(b) - /^https:/.test(a)) : [RDAP_FALLBACK]);
  let last = null;
  for (const base of bases.slice(0, 2)) {
    try {
      const { res, url } = await rdapFetch(base, domain);
      if (res.status === 404) throw Object.assign(new Error('Không có dữ liệu đăng ký công khai cho tên miền này.'), { status: 404 });
      if (!res.ok) { console.warn('[rdap] ' + url + ' -> HTTP ' + res.status); last = 'HTTP ' + res.status + ' từ ' + new URL(url).host; continue; }
      const j = await res.json(), v = {
        domain: domain,
        registrar: rdapName(findEntity(j.entities, 'registrar')), registrant: rdapName(findEntity(j.entities, 'registrant')),
        created: rdapEvent(j, ['registration']), updated: rdapEvent(j, ['last changed']), expires: rdapEvent(j, ['expiration'])
      };
      if (rdapCache.size > 2000) rdapCache.clear();
      rdapCache.set(domain, { t: Date.now(), v: v });
      return v;
    } catch (e) {
      if (e.status) throw e;
      console.warn('[rdap] ' + base + ' lỗi: ' + (e.name || '') + ' ' + e.message); last = (e.name === 'TimeoutError' ? 'quá thời gian chờ' : e.message) + ' (' + new URL(base).host + ')';
    }
  }
  throw Object.assign(new Error('Dịch vụ tra cứu đăng ký đang không khả dụng. Chi tiết: ' + (last || 'không rõ') + '.'), { status: 502 });
}

// ---------- Báo cáo cộng đồng ----------
const reportCache = new Map();
function reportKey(domain) { return Buffer.from(String(domain), 'utf8').toString('base64url'); }
async function communityReports(domain) {
  if (!FIREBASE_DATABASE_URL) return { count: 0, unavailable: true };
  const hit = reportCache.get(domain);
  if (hit && Date.now() - hit.t < 60 * 1000) return hit.v;
  try {
    const res = await fetchT(FIREBASE_DATABASE_URL + '/reports/' + reportKey(domain) + '.json', {}, 6000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const v = { count: Object.keys((await res.json()) || {}).length, unavailable: false };
    if (reportCache.size > 2000) reportCache.clear(); reportCache.set(domain, { t: Date.now(), v: v }); return v;
  } catch (e) { return { count: 0, unavailable: true }; }
}

// ---------- Đánh giá tổng hợp (dùng DG.decide, giống hệt web) ----------
const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
async function evaluateLink(link) {
  const r = DG.analyze(link, index, BRAND);
  const mode = BRAND ? BRAND.mode : 'warn';
  const allowlisted = DG.isAllowlisted(r, allowSet);
  let lookup = null, latinName = null;
  const needLookup = r.nonAscii && r.latin !== r.host && /^[a-z0-9.-]+$/.test(r.latin) && !r.matches.some((m) => m.type === 'visual');
  const domain = DG.registrable(String(r.ascii || r.host).replace(/^www\./, ''));
  const [lk, community, created] = await Promise.all([
    needLookup ? dnsLookup(latinName = DG.registrable(r.latin)) : null,
    communityReports(domain),
    DG.needsCreated(r, mode, allowlisted) ? domainInfo(domain).then((x) => x.created).catch(() => null) : null
  ]);
  lookup = lk;
  const blacklist = BL.check(/^https?:\/\//i.test(link) ? link : 'http://' + link);
  const d = DG.decide({ r: r, rules: BRAND, mode: mode, lookup: lookup, latinName: latinName, blacklist: blacklist, community: community,
    createdDays: created ? ageDays(created) : null, allowlisted: allowlisted, blacklistUnavailable: !!blacklist.empty });
  if (d.brandLogged) console.log('[brand-log]', JSON.stringify({ host: r.ascii, brand: r.brand.brand, type: r.brand.matchType, strength: r.brand.strength, keyword: r.brand.keyword }));
  return { r: r, d: d, community: community, blacklist: blacklist };
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
const defang = (s) => String(s).replace(/\./g, '[.]');
const defangDomains = (s) => String(s).replace(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, defang);
const WELCOME = '👋 Xin chào! Mình là DomainGuard, giúp bạn nhận ra link có dấu hiệu giả mạo trước khi bấm vào.\n\nHãy gửi địa chỉ website hoặc đường link bạn nghi ngờ, ví dụ: amaz0n[.]com\n\nMình phát hiện ký tự giả dạng, tên miền gần giống hoặc lợi dụng thương hiệu, đối chiếu danh sách đen lừa đảo/mã độc và báo cáo từ cộng đồng. Mình chỉ phân tích địa chỉ, không mở trang web.';
const NON_TEXT = '🤔 Mình chưa đọc được loại tin nhắn này (ví dụ ảnh, sticker hoặc tin chuyển tiếp dạng thẻ link).\nHãy sao chép địa chỉ website rồi dán vào tin nhắn chữ nhé.';
const TOO_FAST = '⏳ Bạn gửi hơi nhanh. Vui lòng thử lại sau ít phút.';
const FOOTER = 'ℹ️ DomainGuard chỉ phân tích địa chỉ và đối chiếu danh sách đen, không mở trang web.';
function formatItem(item, many) {
  const r = item.r, d = item.d;
  const lines = [ICON[d.level] + ' ' + d.title, 'Tên miền: ' + defang(r.host)];
  if (r.nonAscii) lines.push('Dạng ASCII: ' + defang(r.ascii));
  if (item.blacklist && item.blacklist.listed) lines.push('⛔ Danh sách đen: ' + item.blacklist.sources.map((s) => s.name).join(', '));
  if (d.brandLevel === 'yellow' || d.brandLevel === 'red') lines.push('🏷️ Website chính thức của ' + d.brand.name + ': ' + d.brand.official.slice(0, 3).map(defang).join(', '));
  d.reasons.slice(0, many ? 2 : 3).forEach((t) => lines.push('• ' + defangDomains(t)));
  if (!many && d.notes.length) lines.push('ℹ️ ' + defangDomains(d.notes[0]));
  if (item.blacklist && item.blacklist.empty) lines.push('ℹ️ Danh sách đen đang được tải, chưa kiểm tra được.');
  if (item.community && item.community.count > 0 && !d.reasons.some((t) => /báo cáo/.test(t))) lines.push('🚩 Cộng đồng: ' + item.community.count + ' báo cáo đáng ngờ.');
  lines.push(d.advice);
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
const seenMsg = new Map();
const rate = new Map();
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
  if (!links.length && /unsupported/i.test(name)) links = extractLinks(deepStrings(m).join(' '));
  if (!links.length) {
    if (!isPrivate) return;
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
  sendJson(res, 200, { ok: true });
  extractEvents(body).forEach((ev) => processZaloEvent(ev).catch((e) => console.error('[zalo] Lỗi xử lý:', redact(e.message))));
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
// Giới hạn số lần gọi API theo IP (Render đặt IP thật ở x-forwarded-for).
const API_LIMIT = Math.max(10, Number(ENV.API_RATE_LIMIT) || 60);
const apiHits = new Map();
setInterval(() => { const now = Date.now(); apiHits.forEach((e, k) => { if (now - e.t > 60000) apiHits.delete(k); }); }, 60000).unref();
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }
function apiAllowed(req) {
  const ip = clientIp(req), now = Date.now();
  let e = apiHits.get(ip);
  if (!e || now - e.t > 60000) { e = { t: now, n: 0 }; apiHits.set(ip, e); }
  return ++e.n <= API_LIMIT;
}
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
    if (/^\/api\/(blacklist|domain-info|brand-log)$/.test(p) && !apiAllowed(req)) return sendJson(res, 429, { error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' }, { 'Retry-After': '60' });
    if (p === '/api/domains' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(res, 200, { domains: state.domains, counts: state.counts, trancoListId: state.trancoListId, updatedAt: state.updatedAt, errors: state.errors,
        blacklist: BL.status(), brandMode: BRAND ? BRAND.mode : null, allowlist: Array.from(allowSet),
        brandRules: BRAND ? { version: BRAND.version, mode: BRAND.mode, brands: Object.keys(BRAND_RAW.brands).length } : null });
    }
    if (p === '/api/blacklist' && req.method === 'GET') {
      const target = String(url.searchParams.get('url') || '').trim();
      if (!target || target.length > 2048) return sendJson(res, 400, { error: 'Địa chỉ không hợp lệ.' });
      const r = BL.check(target);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
    }
    if (p === '/api/domain-info' && req.method === 'GET') {
      const d = clean(url.searchParams.get('domain'));
      if (!d) return sendJson(res, 400, { error: 'Tên miền không hợp lệ.' });
      try { return sendJson(res, 200, await domainInfo(DG.registrable(d))); }
      catch (e) { return sendJson(res, e.status || 502, { error: e.message || 'Không tra cứu được.' }); }
    }
    if (p === '/api/brand-log' && req.method === 'POST') {
      // Trình duyệt gửi khi đang ở chế độ 'log' (chỉ host + thương hiệu), để rà soát báo nhầm.
      try { const j = JSON.parse(await readBody(req, 2048)); console.log('[brand-log]', JSON.stringify({ src: 'web', host: String(j.host || '').slice(0, 253), brand: String(j.brand || '').slice(0, 40), type: String(j.type || '').slice(0, 20), strength: String(j.strength || '').slice(0, 10), keyword: j.keyword ? String(j.keyword).slice(0, 30) : null })); } catch (e) { /* bỏ qua */ }
      return sendJson(res, 200, { ok: true });
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
    console.log('[web] Thương hiệu tích hợp sẵn:', BUILTIN.length, '| Cloudflare:', CF_TOKEN ? 'có token' : 'không có token', '| URLhaus:', URLHAUS_KEY ? 'bật' : 'tắt (thiếu URLHAUS_AUTH_KEY)');
    console.log('[brand] Bộ luật thương hiệu:', BRAND ? (Object.keys(BRAND_RAW.brands).length + ' thương hiệu, chế độ ' + BRAND.mode) : 'KHÔNG nạp được public/brand_rules.json');
    if (ZALO_ENABLED) console.log('[zalo] Bot BẬT, webhook tại ' + ZALO_PATH);
    else console.log('[zalo] Bot TẮT' + (ZALO_TOKEN && !ZALO_SECRET ? ' (có ZALO_BOT_TOKEN nhưng thiếu ZALO_WEBHOOK_SECRET)' : ZALO_SECRET && ZALO_SECRET.length < 8 ? ' (ZALO_WEBHOOK_SECRET phải từ 8 ký tự)' : ''));
  });
  sync();
  setInterval(sync, SOURCES.refreshHours * 3600 * 1000);
  BL.start();
  refreshAllowlist().then(() => console.log('[allowlist]', allowSet.size, 'tên miền'));
  setInterval(refreshAllowlist, 5 * 60 * 1000).unref();
  const stop = () => { console.log('Đang tắt...'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
module.exports = { extractLinks, refang, defangDomains, buildReply, extractEvents, evaluateLink, BL, isOfficialHost, isPopularHost, _setAllow: (arr) => { allowSet = new Set(arr); } };
