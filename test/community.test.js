// Kiểm thử đầu-cuối bot Zalo + báo cáo cộng đồng (Firebase REST giả lập, không cần mạng). Chạy: node test/community.test.js
const http = require('http'), { spawn } = require('child_process');
const M = 3501, A = 3502, A2 = 3503, KEY = Buffer.from('vnexpress.net').toString('base64url');
const sent = []; const fbCalls = [];
const mock = http.createServer((q, r) => {
  let b = ''; q.on('data', (d) => b += d);
  q.on('end', () => {
    const u = new URL(q.url, 'http://x'); r.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/botZT/sendMessage') { sent.push(JSON.parse(b)); return r.end('{"ok":true}'); }
    if (u.pathname === '/resolve') return r.end(JSON.stringify({ Status: u.searchParams.get('name') === 'abribank.com.vn' ? 3 : 0 }));
    if (u.pathname === '/fb/reports/' + KEY + '.json') { fbCalls.push(u.pathname); return r.end(JSON.stringify({ u2: { reason: 'investment_scam' }, u3: { reason: 'other' } })); }
    if (u.pathname.startsWith('/fb/reports/')) { fbCalls.push(u.pathname); return r.end('null'); }
    r.statusCode = 404; r.end('{}');
  });
});
function start(port, env) {
  return spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: require('path').join(require('os').tmpdir(), 'dg-test-' + port),
      ZALO_API_BASE: 'http://localhost:' + M, TRANCO_API_BASE: 'http://localhost:' + M,
      CF_API_BASE: 'http://localhost:' + M, DNS_API_BASE: 'http://localhost:' + M + '/resolve'
    }, env)
  });
}
const post = (port, text, id) => new Promise((res) => {
  const d = JSON.stringify({ event_name: 'message.text.received', message: { from: { id: 'u' }, chat: { id: 'c' + id, chat_type: 'PRIVATE' }, text: text, message_id: 'm' + id } });
  const q = http.request({ host: 'localhost', port: port, method: 'POST', path: '/zalo/webhook', headers: { 'Content-Type': 'application/json', 'X-Bot-Api-Secret-Token': 'secret-12345' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
  q.write(d); q.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port, p) => new Promise((res, rej) => http.get({ host: 'localhost', port: port, path: p }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ s: r.statusCode, b: b })); }).on('error', rej));
let ok = 0, bad = 0;
const T = (n, c, x) => { c ? ok++ : bad++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : '→ ' + x); };
(async () => {
  await new Promise((r) => mock.listen(M, r));
  const a = start(A, { ZALO_BOT_TOKEN: 'ZT', ZALO_WEBHOOK_SECRET: 'secret-12345', FIREBASE_DATABASE_URL: 'http://localhost:' + M + '/fb/' });
  const b = start(A2, { ZALO_BOT_TOKEN: 'ZT', ZALO_WEBHOOK_SECRET: 'secret-12345', FIREBASE_DATABASE_URL: '' });
  for (let i = 0; i < 50; i++) { try { await get(A, '/healthz'); await get(A2, '/healthz'); break; } catch (e) { await sleep(100); } }
  const last = async (n) => { for (let i = 0; i < 30; i++) { if (sent.length > n) return sent[sent.length - 1].text; await sleep(100); } return null; };
  let n = sent.length, t;
  await post(A, 'vnexpress.net', 1); t = await last(n);
  T('có report: xanh → vàng + hiện số báo cáo', t && /⚠️ CẦN KIỂM TRA THÊM/.test(t) && /Cộng đồng: 2 báo cáo/.test(t), t);
  n = sent.length; await post(A, 'example.org', 2); t = await last(n);
  T('không có report: vẫn xanh, không nhắc cộng đồng', t && /✅/.test(t) && !/Cộng đồng/.test(t), t);
  n = sent.length; await post(A, 'amaz0n.com', 3); t = await last(n);
  T('đỏ của engine được giữ nguyên', t && /🚨/.test(t), t);
  n = sent.length; await post(A, 'https://www.vnexpress.net/abc', 4); t = await last(n);
  T('www + đường dẫn: vẫn tra đúng tên miền gốc', t && /Cộng đồng: 2/.test(t), t);
  T('server tra Firebase đúng khoá base64url, bỏ dấu / cuối URL', fbCalls.includes('/fb/reports/' + KEY + '.json'), fbCalls.join(','));
  const calls = fbCalls.length; await post(A, 'vnexpress.net', 5); await sleep(500);
  T('cache 60 giây: tra lại cùng tên miền không gọi Firebase thêm', fbCalls.length === calls, fbCalls.length - calls);
  n = sent.length; await post(A, 'hello', 6); t = await last(n);
  T('lời chào mới', t && /giúp bạn nhận ra link có dấu hiệu giả mạo/.test(t) && /không mở trang web/.test(t), t);
  n = sent.length; await post(A2, 'vnexpress.net', 7); t = await last(n);
  T('không đặt FIREBASE_DATABASE_URL: bot vẫn chạy, ra xanh', t && /✅/.test(t), t);
  const w = await get(A, '/'); T('web app vẫn phục vụ index.html có Firebase + modal', w.s === 200 && /firebase-auth-compat/.test(w.b) && /reportModal/.test(w.b), w.s);
  const f = await get(A, '/firebase-config.js'); T('firebase-config.js được phục vụ', f.s === 200 && /DOMAIN_GUARD_FIREBASE_CONFIG/.test(f.b), f.s);
  const s = await get(A, '/server.js'); T('server.js KHÔNG bị lộ qua web', s.s === 404, s.s);
  const d = await get(A, '/database.rules.json'); T('database.rules.json không bị lộ qua web', d.s === 404, d.s);
  const api = JSON.parse((await get(A, '/api/domains')).b); T('/api/domains giữ nguyên cấu trúc', Array.isArray(api.domains) && api.counts && 'errors' in api);
  console.log('\n=== ' + ok + ' đạt, ' + bad + ' lỗi ===');
  a.kill('SIGKILL'); b.kill('SIGKILL'); mock.close(); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
