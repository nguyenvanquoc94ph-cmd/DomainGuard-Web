// DomainGuard detector - dùng chung cho trình duyệt và Node (kiểm thử).
(function (root) {
  'use strict';

  // Ký tự Unicode trông giống Latin (tập con của UTS #39 confusables).
  var CONFUSABLE = {
    'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','һ':'h','ԁ':'d','ӏ':'l','ԛ':'q','ԝ':'w','к':'k','м':'m','т':'t','в':'b','н':'h',
    'α':'a','ο':'o','ε':'e','ρ':'p','ν':'v','τ':'t','κ':'k','ι':'i','υ':'u','χ':'x',
    'ɑ':'a','ɡ':'g','ı':'i','ȷ':'j','ⅼ':'l','ℓ':'l'
  };
  // Ký tự Latin/số dễ nhầm.
  var LATIN_SWAP = { '0':'o', '1':'l', '5':'s', '3':'e', '8':'b', '6':'b', '9':'g' };

  function hasNonAscii(s) { return /[^\x00-\x7f]/.test(s); }

  // Dạng hình dạng (skeleton) dùng để so sánh, không dùng để truy cập.
  function skeleton(s) {
    var chars = Array.from(String(s).normalize('NFKC').toLowerCase());
    var out = chars.map(function (c) { return CONFUSABLE[c] || LATIN_SWAP[c] || c; }).join('');
    return out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  }

  // Chuyển ký tự Unicode giống Latin sang Latin, giữ nguyên ký tự Latin (dùng để tra cứu trực tuyến).
  function toLatin(s) {
    return Array.from(String(s).normalize('NFKC').toLowerCase()).map(function (c) { return CONFUSABLE[c] || c; }).join('');
  }

  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    var row = []; for (var k = 0; k <= b.length; k++) row[k] = k;
    for (var i = 1; i <= a.length; i++) {
      var next = [i];
      for (var j = 1; j <= b.length; j++) next[j] = Math.min(next[j-1] + 1, row[j] + 1, row[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  }

  function parseHost(input) {
    var text = String(input || '').trim().normalize('NFC');
    if (!text) throw new Error('Vui lòng nhập địa chỉ website.');
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
    var m = text.match(/^https?:\/\/([^\/?#]+)/i);
    var raw = (m ? m[1] : '').replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
    if (!raw || /[\s\\]/.test(raw)) throw new Error('URL không hợp lệ.');
    var ascii;
    try { ascii = new URL('https://' + raw).hostname.toLowerCase(); } catch (e) { throw new Error('URL không hợp lệ.'); }
    return { raw: raw, ascii: ascii };
  }

  // Lấy n nhãn cuối của hostname, ví dụ lastLabels('www.a.com.vn', 3) = 'a.com.vn'.
  function lastLabels(host, n) { var p = host.split('.'); return p.slice(Math.max(0, p.length - n)).join('.'); }

  function buildIndex(domains) {
    var list = [], set = new Set();
    domains.forEach(function (d) {
      if (set.has(d)) return; set.add(d);
      list.push({ domain: d, labels: d.split('.').length, sk: skeleton(d) });
    });
    return { list: list, set: set };
  }

  function analyze(input, index) {
    var p = parseHost(input);
    var host = p.raw.replace(/^www\./, '');
    var nonAscii = hasNonAscii(host) || p.ascii.indexOf('xn--') !== -1;
    // Tên miền khớp chính xác hoặc là subdomain thật của tên miền tham chiếu.
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join('.');
      if (index.set.has(suffix)) {
        return { host: p.raw, ascii: p.ascii, nonAscii: nonAscii, latin: toLatin(host), matches: [], canonical: suffix, status: 'known' };
      }
    }
    var matches = [];
    var cache = {};
    index.list.forEach(function (t) {
      var part = cache[t.labels] || (cache[t.labels] = lastLabels(host, t.labels));
      var sk = cache['s' + t.labels] || (cache['s' + t.labels] = skeleton(part));
      if (sk === t.sk) { matches.push({ domain: t.domain, type: 'visual', d: 0 }); return; }
      var name = t.domain.split('.')[0];
      if (name.length >= 5) {
        var d = distance(sk, t.sk);
        if (d === 1) matches.push({ domain: t.domain, type: 'edit', d: d });
      }
    });
    matches.sort(function (a, b) { return a.d - b.d; });
    return { host: p.raw, ascii: p.ascii, nonAscii: nonAscii, latin: toLatin(host), matches: matches.slice(0, 5), canonical: null, status: (matches.length || nonAscii) ? 'warning' : 'clear' };
  }

  var api = { skeleton: skeleton, toLatin: toLatin, distance: distance, parseHost: parseHost, buildIndex: buildIndex, analyze: analyze, hasNonAscii: hasNonAscii };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DomainGuard = api;
})(this);
