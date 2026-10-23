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
    var out = Array.from(String(s).normalize('NFKC').toLowerCase())
      .map(function (c) { return CONFUSABLE[c] || LATIN_SWAP[c] || c; }).join('');
    return out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  }

  // Chỉ đổi ký tự Unicode giống Latin sang Latin (dùng để tra cứu tên miền thật).
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

  function lastLabels(host, n) { var p = host.split('.'); return p.slice(Math.max(0, p.length - n)).join('.'); }

  function buildIndex(domains) {
    var list = [], set = new Set();
    domains.forEach(function (d) {
      if (set.has(d)) return; set.add(d);
      list.push({ domain: d, labels: d.split('.').length, sk: skeleton(d) });
    });
    return { list: list, set: set };
  }

  // Trả về dữ kiện thô. Việc chọn mức đỏ/vàng/xanh nằm ở rate().
  function analyze(input, index) {
    var p = parseHost(input);
    var host = p.raw.replace(/^www\./, '');
    var nonAscii = hasNonAscii(host) || p.ascii.indexOf('xn--') !== -1;
    var base = { host: p.raw, ascii: p.ascii, nonAscii: nonAscii, latin: toLatin(host), matches: [], canonical: null };

    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join('.');
      if (index.set.has(suffix)) { base.canonical = suffix; return base; }
    }
    var cacheLabel = {}, cacheSk = {};
    index.list.forEach(function (t) {
      var part = cacheLabel[t.labels] || (cacheLabel[t.labels] = lastLabels(host, t.labels));
      var sk = cacheSk[t.labels] || (cacheSk[t.labels] = skeleton(part));
      var name = t.domain.split('.')[0];
      if (sk === t.sk) {
        // Tên quá ngắn (vd "g0.com") dễ trùng ngẫu nhiên: chỉ tính khi tên miền có ký tự lạ hoặc tên >= 4 ký tự.
        if (nonAscii || name.length >= 4) base.matches.push({ domain: t.domain, type: 'visual' });
      } else if (name.length >= 5 && distance(sk, t.sk) === 1) {
        base.matches.push({ domain: t.domain, type: 'edit' });
      }
    });
    base.matches.sort(function (a, b) { return (a.type === 'visual' ? 0 : 1) - (b.type === 'visual' ? 0 : 1); });
    base.matches = base.matches.slice(0, 5);
    return base;
  }

  // Xếp mức rủi ro. lookup: null (không tra cứu) | 'found' | 'missing' | 'unknown'.
  //  red    = nguy cơ cao: trùng hình dạng với tên miền tham chiếu, hoặc tên miền Latin tương ứng đang tồn tại
  //  yellow = bất thường nhưng chưa đủ để đánh giá nguy cơ cao
  //  green  = chưa tìm thấy dấu hiệu bất thường (KHÔNG khẳng định an toàn)
  function rate(r, lookup, latinName) {
    var reasons = [], level = 'green';
    var visual = r.matches.filter(function (m) { return m.type === 'visual'; });
    var edit = r.matches.filter(function (m) { return m.type === 'edit'; });

    if (visual.length) {
      level = 'red';
      reasons.push(r.nonAscii
        ? 'Tên miền dùng ký tự ngoài bảng chữ Latin nhưng trông giống hệt ' + visual[0].domain + '.'
        : 'Tên miền giả dạng ' + visual[0].domain + ' bằng cách thay hoặc ghép ký tự (ví dụ 0 thay o, rn thay m).');
    }
    if (r.nonAscii && lookup === 'found') {
      level = 'red';
      reasons.push('Sau khi chuyển sang Latin, tên miền ' + latinName + ' đang tồn tại: có 2 tên miền trông gần như giống nhau.');
    }
    if (level !== 'red') {
      if (r.nonAscii) {
        level = 'yellow';
        reasons.push('Tên miền chứa ký tự ngoài bảng chữ Latin.');
        if (lookup === 'missing') reasons.push('Không tìm thấy tên miền Latin tương ứng (' + latinName + ') để đối chiếu.');
        else if (lookup === 'unknown') reasons.push('Không tra cứu được tên miền Latin tương ứng, nên chưa đối chiếu được.');
        else reasons.push('Không chuyển được sang tên miền Latin để đối chiếu.');
      }
      if (edit.length) {
        level = 'yellow';
        reasons.push('Tên miền chỉ khác 1 ký tự so với ' + edit[0].domain + ' (có thể là lỗi đánh máy hoặc cố tình bắt chước).');
      }
    }
    return { level: level, reasons: reasons };
  }

  var api = { skeleton: skeleton, toLatin: toLatin, distance: distance, parseHost: parseHost, buildIndex: buildIndex, analyze: analyze, rate: rate, hasNonAscii: hasNonAscii };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DomainGuard = api;
})(this);
