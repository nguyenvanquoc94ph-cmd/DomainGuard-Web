// DomainGuard blacklist: tải danh sách đen miễn phí về máy chủ, tra cứu tại chỗ (không gửi URL người dùng ra bên thứ 3).
// Nguồn mặc định:
//   - OpenPhish Community (URL lừa đảo, cập nhật ~12 giờ, chỉ dùng phi thương mại)
//   - Phishing.Database ACTIVE (tên miền lừa đảo đang hoạt động)
//   - URLhaus / abuse.ch (URL phát tán mã độc) - CHỈ bật khi có biến môi trường URLHAUS_AUTH_KEY (miễn phí)
'use strict';
const fs = require('fs');
const path = require('path');

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// Dịch vụ lưu trữ dùng chung: KHÔNG bao giờ gắn cờ cả tên miền gốc, chỉ gắn cờ subdomain/URL cụ thể.
const SHARED_HOSTS = new Set(['github.io', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'web.app', 'firebaseapp.com',
  'weebly.com', 'wixsite.com', 'blogspot.com', '000webhostapp.com', 'herokuapp.com', 'glitch.me', 'repl.co', 'replit.app',
  'onrender.com', 'azurewebsites.net', 'appspot.com', 'r2.dev', 'ipfs.io', 'webflow.io', 'square.site', 'godaddysites.com',
  'sites.google.com', 'docs.google.com', 'forms.gle', 'bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'cutt.ly', 'linktr.ee',
  'translate.goog', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'duckdns.org', 'no-ip.com']);

const FEEDS = {
  openphish: { name: 'OpenPhish', category: 'phishing', kind: 'url',
    urls: () => ['https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt', 'https://openphish.com/feed.txt'] },
  phishingDatabase: { name: 'Phishing.Database', category: 'phishing', kind: 'domain',
    urls: () => ['https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt'] },
  urlhaus: { name: 'URLhaus (abuse.ch)', category: 'malware', kind: 'url', keyEnv: 'URLHAUS_AUTH_KEY',
    urls: (key) => ['https://urlhaus-api.abuse.ch/v2/files/exports/' + encodeURIComponent(key) + '/recent.csv'] }
};
const CATEGORY_LABEL = { phishing: 'lừa đảo/đánh cắp thông tin', malware: 'phát tán mã độc' };

function normHost(h) {
  h = String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (h.startsWith('[')) return null;   // bỏ qua IPv6
  return DOMAIN_RE.test(h) || IPV4_RE.test(h) ? h : null;
}
// Chuẩn hoá URL để so khớp: host + path (bỏ / cuối) + query. Không phân biệt http/https.
function parseUrl(input) {
  let t = String(input || '').trim();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'http://' + t;
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  const host = normHost(u.hostname);
  if (!host) return null;
  let p = u.pathname.replace(/\/+$/, '');
  return { host: host, key: host + p + u.search };
}

function createBlacklist(opts) {
  const o = Object.assign({ refreshHours: 6, maxPerFeed: 300000, enabled: {} }, opts || {});
  const DATA_FILE = path.join(o.dataDir, 'blacklist.json');
  const log = o.log || console;
  const redact = o.redact || ((s) => s);
  const registrable = o.registrable || ((h) => h.split('.').slice(-2).join('.'));
  const isTrusted = o.isTrusted || (() => false);
  const ids = Object.keys(FEEDS);
  let perFeed = {};            // id -> { hosts:[], urls:[], count, updatedAt, error, ok }
  let hostMap = new Map(), urlMap = new Map();   // giá trị = bitmask nguồn
  let syncing = false, lastSync = null;

  const active = (id) => {
    const f = FEEDS[id];
    if (o.enabled[id] === false) return false;
    if (f.keyEnv && !process.env[f.keyEnv]) return false;
    return true;
  };

  function rebuild() {
    const hm = new Map(), um = new Map();
    ids.forEach((id, i) => {
      const d = perFeed[id]; if (!d) return;
      const bit = 1 << i;
      (d.hosts || []).forEach((h) => hm.set(h, (hm.get(h) || 0) | bit));
      (d.urls || []).forEach((u) => um.set(u, (um.get(u) || 0) | bit));
    });
    hostMap = hm; urlMap = um;
  }

  function parseFeed(id, text) {
    const f = FEEDS[id], hosts = new Set(), urls = new Set();
    const lines = text.split(/\r?\n/);
    for (const line0 of lines) {
      if (hosts.size + urls.size >= o.maxPerFeed) break;
      const line = line0.trim();
      if (!line || line[0] === '#' || line[0] === '!') continue;
      if (f.kind === 'domain') {
        const h = normHost(line.replace(/^(0\.0\.0\.0|127\.0\.0\.1)\s+/, '').split(/\s/)[0]);
        if (h && h.includes('.') && !SHARED_HOSTS.has(h)) hosts.add(h);
      } else {
        const found = line.match(/https?:\/\/[^\s",']+/gi) || [];
        for (const raw of found) {
          const p = parseUrl(raw);
          if (!p) continue;
          urls.add(p.key);
          // Chỉ gắn cờ cả host khi KHÔNG phải dịch vụ lưu trữ dùng chung.
          if (!SHARED_HOSTS.has(p.host)) hosts.add(p.host);
        }
      }
    }
    return { hosts: Array.from(hosts), urls: Array.from(urls) };
  }

  async function fetchFeed(id) {
    const f = FEEDS[id], key = f.keyEnv ? process.env[f.keyEnv] : null;
    let last = '';
    for (const url of f.urls(key)) {
      try {
        const res = await o.fetchT(url, { headers: { 'User-Agent': o.userAgent || 'DomainGuard/0.6' } }, 120000);
        if (!res.ok) { last = 'HTTP ' + res.status; continue; }
        return parseFeed(id, await res.text());
      } catch (e) { last = e.name === 'TimeoutError' ? 'quá thời gian chờ' : e.message; }
    }
    throw new Error(last || 'không tải được');
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (j && j.feeds) { perFeed = j.feeds; lastSync = j.updatedAt || null; rebuild(); log.log('[blacklist] Đã nạp bản lưu:', hostMap.size, 'host,', urlMap.size, 'URL'); }
    } catch (e) { /* chưa có bản lưu */ }
  }
  function save() {
    try {
      fs.mkdirSync(o.dataDir, { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ updatedAt: lastSync, feeds: perFeed }));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { log.warn('[blacklist] Không ghi được bản lưu:', e.message); }
  }

  async function sync() {
    if (syncing) return; syncing = true;
    try {
      let changed = false;
      for (const id of ids) {
        if (!active(id)) continue;
        try {
          const r = await fetchFeed(id);
          if (!r.hosts.length && !r.urls.length) throw new Error('danh sách rỗng');
          perFeed[id] = { hosts: r.hosts, urls: r.urls, count: r.hosts.length + r.urls.length, updatedAt: new Date().toISOString(), ok: true, error: null };
          changed = true;
        } catch (e) {
          // Lỗi nguồn nào thì giữ lại dữ liệu cũ của nguồn đó.
          perFeed[id] = Object.assign({ hosts: [], urls: [], count: 0 }, perFeed[id] || {}, { ok: false, error: redact(e.message) });
          log.warn('[blacklist]', FEEDS[id].name, 'lỗi:', redact(e.message));
        }
      }
      if (changed) { lastSync = new Date().toISOString(); rebuild(); save(); }
      log.log('[blacklist] Xong:', hostMap.size, 'host,', urlMap.size, 'URL');
    } finally { syncing = false; }
  }

  function sourcesOf(mask) {
    return ids.filter((id, i) => mask & (1 << i)).map((id) => ({ id: id, name: FEEDS[id].name, category: FEEDS[id].category, categoryLabel: CATEGORY_LABEL[FEEDS[id].category] }));
  }

  // input: URL đầy đủ hoặc tên miền. Trả về { listed, matches:[{type:'url'|'host', value, sources:[...]}] }
  function check(input) {
    const p = parseUrl(input);
    if (!p) return { listed: false, matches: [], error: 'URL không hợp lệ' };
    const matches = [];
    const um = urlMap.get(p.key);
    if (um) matches.push({ type: 'url', value: p.key, sources: sourcesOf(um) });
    // Tên miền đáng tin/phổ biến (danh sách tham chiếu) không bị gắn cờ theo host, chỉ theo URL chính xác.
    const trusted = isTrusted(p.host);
    if (!trusted) {
      const parts = p.host.split('.'), stop = IPV4_RE.test(p.host) ? 1 : registrable(p.host).split('.').length;
      for (let i = 0; parts.length - i >= stop; i++) {
        const s = parts.slice(i).join('.');
        if (SHARED_HOSTS.has(s)) break;
        const m = hostMap.get(s);
        if (m) { matches.push({ type: 'host', value: s, sources: sourcesOf(m) }); break; }
        if (IPV4_RE.test(p.host)) break;
      }
    }
    const seen = new Map();
    matches.forEach((m) => m.sources.forEach((s) => seen.set(s.id, s)));
    return { listed: matches.length > 0, matches: matches, sources: Array.from(seen.values()), trustedHost: trusted, updatedAt: lastSync, empty: hostMap.size + urlMap.size === 0 };
  }

  function status() {
    const feeds = {};
    ids.forEach((id) => {
      const d = perFeed[id] || {};
      feeds[id] = { name: FEEDS[id].name, active: active(id), needsKey: FEEDS[id].keyEnv && !process.env[FEEDS[id].keyEnv] ? FEEDS[id].keyEnv : null,
        count: d.count || 0, ok: d.ok !== false && !!d.count, error: d.error || null, updatedAt: d.updatedAt || null };
    });
    return { updatedAt: lastSync, hosts: hostMap.size, urls: urlMap.size, feeds: feeds };
  }

  function start() {
    load(); sync();
    setInterval(sync, o.refreshHours * 3600 * 1000).unref();
  }

  return { load, sync, check, status, start, parseFeed, _setFeed: (id, d) => { perFeed[id] = d; rebuild(); } };
}

module.exports = { createBlacklist, FEEDS, SHARED_HOSTS, parseUrl };
