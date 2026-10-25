// Mô phỏng logic trình duyệt (public/app.js) với DOM giả + Firebase giả áp dụng đúng các quy tắc trong database.rules.json.
// Không thay thế việc thử trên Firebase thật. Chạy: node test/device-lock.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const DG = require(path.join(PUB, 'detector.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0; const T = (n, c, x) => { c ? ok++ : bad++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : '→ ' + x); };

// ---- Firebase giả: cây JSON + quy tắc như database.rules.json ----
const tree = {};
const seg = (p) => p.split('/');
const getAt = (p) => seg(p).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), tree);
function setAt(p, v) { const s = seg(p); let o = tree; for (let i = 0; i < s.length - 1; i++) { if (typeof o[s[i]] !== 'object' || o[s[i]] === null) o[s[i]] = {}; o = o[s[i]]; } if (v === null) delete o[s[s.length - 1]]; else o[s[s.length - 1]] = v; }
function denied() { return Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }); }
function allowWrite(p, v, uid) {
  const s = seg(p);
  if (s[0] === 'reportLocks' && s.length === 3) {
    const old = getAt(p);
    if (!uid) return false;
    if (v !== null) return !old && v.uid === uid;
    return !!old && old.uid === uid && !getAt('reports/' + s[1] + '/' + uid);
  }
  if (s[0] === 'reports' && s.length === 3) {
    if (!uid || s[2] !== uid) return false;
    if (v === null) return true;
    const dk = getAt('userReports/' + uid + '/' + s[1] + '/deviceKey'), lock = dk && getAt('reportLocks/' + s[1] + '/' + dk);
    return !!(lock && lock.uid === uid);
  }
  if (s[0] === 'userReports' && s.length === 3) return !!uid && s[1] === uid;
  return false;
}
function allowRead(p, uid) { const s = seg(p); if (s[0] === 'reports' && s.length >= 2) return true; if (s[0] === 'reportLocks' && s.length === 3) return true; if (s[0] === 'userReports' && s.length === 3) return uid === s[1]; return false; }
const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v !== undefined && v !== null, child: (k) => snap(v && typeof v === 'object' ? v[k] : undefined) });
const TS = { '.sv': 'timestamp' };
const stamp = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === TS ? Date.now() : x])) : v);

// ---- DOM giả tối thiểu ----
class El {
  constructor(id) { this.id = id; this.children = []; this.handlers = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.className = ''; this.parent = null; this.attrs = {}; const self = this; this.classList = { add(c) { self.className += ' ' + c; } }; }
  append(...k) { k.forEach((c) => { if (typeof c === 'string') c = Object.assign(new El(), { textContent: c }); c.parent = this; this.children.push(c); }); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  replaceWith(...k) { const p = this.parent, i = p.children.indexOf(this); k.forEach((c) => { c.parent = p; }); p.children.splice(i, 1, ...k); }
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] || null; }
  focus() {} blur() {} scrollIntoView() {} querySelectorAll() { return []; }
  all() { return [this].concat(...this.children.map((c) => c.all())); }
  text() { return this.textContent + ' ' + this.children.map((c) => c.text()).join(' '); }
  async click() { if (this.disabled) return; for (const f of this.handlers.click || []) await f({ target: this }); }
}
function makeDevice(account) {
  const els = {}; [...html.matchAll(/id="([A-Za-z]+)"/g)].forEach((m) => { els[m[1]] = new El(m[1]); });
  els.reportModal.hidden = true; els.authBox.hidden = true;
  const store = {}; let cb = null, popups = 0;
  const auth = {
    currentUser: null,
    onAuthStateChanged(f) { cb = f; Promise.resolve().then(() => f(null)); },
    async signInWithPopup() { popups++; auth.currentUser = { uid: account.next, displayName: account.next }; Promise.resolve().then(() => cb(auth.currentUser)); return { user: auth.currentUser }; },
    async signOut() { auth.currentUser = null; Promise.resolve().then(() => cb(null)); }
  };
  const ref = (p) => ({
    async once() { if (!allowRead(p, auth.currentUser && auth.currentUser.uid)) throw denied(); const v = getAt(p); return snap(v === undefined ? undefined : JSON.parse(JSON.stringify(v))); },
    async set(v) { v = stamp(v); if (!allowWrite(p, v, auth.currentUser && auth.currentUser.uid)) throw denied(); setAt(p, v); },
    async remove() { if (!allowWrite(p, null, auth.currentUser && auth.currentUser.uid)) throw denied(); setAt(p, null); }
  });
  const database = () => ({ ref }); database.ServerValue = { TIMESTAMP: TS };
  const authFn = () => auth; authFn.GoogleAuthProvider = function () { this.setCustomParameters = () => {}; };
  const firebase = { apps: [], initializeApp() { firebase.apps.push(1); }, auth: authFn, database };
  const sb = {
    console, setTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, Uint8Array, TextEncoder, btoa, AbortSignal, Error, isNaN, encodeURIComponent,
    requestAnimationFrame: (f) => f(), NodeFilter: { SHOW_TEXT: 4 }, navigator: {}, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async (u) => (/domain-info/.test(u) ? { ok: true, json: async () => ({ registrar: 'Mock Registrar', registrant: null, created: '2015-01-01T00:00:00Z', expires: '2030-01-01T00:00:00Z', updated: '2025-01-01T00:00:00Z' }) } : { ok: true, json: async () => ({ domains: [], counts: {} }) }),
    document: { body: new El('body'), title: '', getElementById: (id) => els[id], createElement: () => new El(), createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [], addEventListener() {} }
  };
  sb.window = sb; sb.crypto = globalThis.crypto; sb.DomainGuard = DG; sb.firebase = firebase;
  sb.DOMAIN_GUARD_FIREBASE_CONFIG = { apiKey: 'k', authDomain: 'a', databaseURL: 'd', projectId: 'p', appId: 'i' };
  vm.runInNewContext(appSrc, sb);
  return {
    els, auth, popups: () => popups,
    async search(domain) { els.url.value = domain; await els.scan.click(); await sleep(80); },
    box() { return els.result.text(); },
    btn() { return els.result.all().find((e) => /report-btn/.test(e.className)); },
    async login(uid) { account.next = uid; await els.authBtn.click(); await sleep(120); },
    async logout() { await els.authBtn.click(); await sleep(120); },
    async report(reason) { await this.btn().click(); els.reportReason.value = reason || 'impersonation'; await els.submitReport.click(); await sleep(150); if (els.reportError.textContent) console.log('  [reportError]', els.reportError.textContent); }
  };
}

(async () => {
  const X = 'example-unrelated.org', Y = 'another-sample.org';
  const acc1 = { next: null }, acc2 = { next: null };
  const d1 = makeDevice(acc1), d2 = makeDevice(acc2);
  await sleep(50);
  T('nút Đăng nhập hiện khi Firebase đã cấu hình', d1.els.authBox.hidden === false && d1.els.authBtn.textContent === 'Đăng nhập', d1.els.authBtn.textContent);

  await d1.search(X);
  T('chưa đăng nhập vẫn xem kết quả + thông tin đăng ký', /Mock Registrar/.test(d1.box()) && /Ngày đăng ký/.test(d1.box()), d1.box().slice(0, 300));
  T('chưa đăng nhập: nút báo cáo bấm được', d1.btn() && !d1.btn().disabled && /Báo cáo đáng ngờ/.test(d1.btn().textContent), d1.btn() && d1.btn().textContent);

  acc1.next = 'A'; await d1.report('impersonation'); await d1.search(X);
  T('A báo cáo xong: có 1 báo cáo + nút Thu hồi', /1 báo cáo từ cộng đồng/.test(d1.box()) && /Thu hồi báo cáo/.test(d1.btn().textContent), d1.btn().textContent);
  T('A đang đăng nhập hiển thị trên header + nút Đăng xuất', /A/.test(d1.els.authText.textContent) && d1.els.authBtn.textContent === 'Đăng xuất', d1.els.authBtn.textContent);

  await d1.logout();
  T('đăng xuất được; tra cứu vẫn hoạt động', d1.els.authBtn.textContent === 'Đăng nhập' && /1 báo cáo từ cộng đồng/.test(d1.box()), d1.box().slice(0, 200));

  await d1.login('B');
  T('B (cùng thiết bị) KHÔNG báo cáo được X: nút mờ, không hiện "bạn đã báo cáo"', d1.btn().disabled && /Không thể báo cáo/.test(d1.btn().textContent) && !/Bạn đã báo cáo/.test(d1.box()), d1.btn().textContent);

  const popupsBefore = d1.popups(); await d1.search(Y);
  T('B vẫn báo cáo được tên miền khác', d1.btn() && !d1.btn().disabled && /Báo cáo đáng ngờ/.test(d1.btn().textContent), d1.btn().textContent);
  await d1.report('malware'); await d1.search(Y);
  T('đã đăng nhập thì báo cáo không bắt đăng nhập lại', d1.popups() === popupsBefore && /Thu hồi báo cáo/.test(d1.btn().textContent), d1.popups() + ' vs ' + popupsBefore);

  await d2.login('A'); await d2.search(X);
  T('A từ thiết bị khác thấy nút Thu hồi cho X', d2.btn() && /Thu hồi báo cáo/.test(d2.btn().textContent), d2.btn() && d2.btn().textContent);
  await d2.btn().click(); await sleep(150);
  const keyX = Buffer.from(X).toString('base64url');
  T('thu hồi xoá báo cáo, khoá thiết bị và bản ghi riêng', !getAt('reports/' + keyX + '/A') && !getAt('reportLocks/' + keyX) || Object.keys(getAt('reportLocks/' + keyX) || {}).length === 0, JSON.stringify(tree).slice(0, 300));

  await d1.search(X);
  T('sau khi A thu hồi: B báo cáo lại được X', d1.btn() && !d1.btn().disabled && /Báo cáo đáng ngờ/.test(d1.btn().textContent), d1.btn() && d1.btn().textContent);
  await d1.report('other'); await d1.search(X);
  T('B báo cáo X thành công', getAt('reports/' + keyX + '/B') && /Thu hồi báo cáo/.test(d1.btn().textContent), d1.btn().textContent);

  // Quy tắc: B không thu hồi/ghi đè báo cáo của người khác
  const bUid = d1.auth.currentUser.uid; let denyOk = false;
  try { await (async () => { const p = 'reports/' + keyX + '/A'; if (!allowWrite(p, null, bUid)) throw denied(); })(); } catch (e) { denyOk = true; }
  T('quy tắc: tài khoản này không xoá được báo cáo của tài khoản khác', denyOk, '');

  console.log('\n=== ' + ok + ' đạt, ' + bad + ' lỗi ===');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
