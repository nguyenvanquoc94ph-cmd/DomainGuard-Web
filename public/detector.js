// DomainGuard detector - dùng chung cho trình duyệt và Node (kiểm thử).
(function (root) {
  'use strict';

  // true: cùng tên thương hiệu nhưng khác đuôi (vd vietcombank.com và vietcombank.com.vn) bị đánh mức vàng.
  var FLAG_SAME_BRAND_OTHER_TLD = true;
  var MIN_BRAND_LEN = 5;   // thương hiệu ngắn hơn dễ trùng ngẫu nhiên nên không so theo tên thương hiệu

  // Ký tự Unicode trông giống Latin (tập con của UTS #39 confusables).
  var CONFUSABLE = {
    'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','һ':'h','ԁ':'d','ӏ':'l','ԛ':'q','ԝ':'w','к':'k','м':'m','т':'t','в':'b','н':'h',
    'α':'a','ο':'o','ε':'e','ρ':'p','ν':'v','τ':'t','κ':'k','ι':'i','υ':'u','χ':'x',
    'ɑ':'a','ɡ':'g','ı':'i','ȷ':'j','ⅼ':'l','ℓ':'l'
  };
  // Ký tự Latin/số dễ nhầm.
  var LATIN_SWAP = { '0':'o', '1':'l', '5':'s', '3':'e', '8':'b', '6':'b', '9':'g' };
  // Hậu tố hai cấp thường gặp (xấp xỉ Public Suffix List): com.vn, co.uk, ...
  var SLD = ['com','net','org','edu','gov','co','ac','or','ne','go','info','biz'];

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

  // Tên miền có thể đăng ký (xấp xỉ): hậu tố hai cấp như com.vn thì lấy 3 nhãn cuối.
  function registrable(host) {
    var p = host.split('.');
    if (p.length >= 3 && p[p.length - 1].length === 2 && SLD.indexOf(p[p.length - 2]) !== -1) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  function buildIndex(domains) {
    var list = [], set = new Set();
    domains.forEach(function (d) {
      d = String(d || '').trim().toLowerCase();
      if (!d || set.has(d)) return; set.add(d);
      var reg = registrable(d), brand = reg.split('.')[0];
      list.push({ domain: d, labels: d.split('.').length, sk: skeleton(d), reg: reg, brand: brand, bsk: skeleton(brand) });
    });
    return { list: list, set: set };
  }

  // Trả về dữ kiện thô. Việc chọn mức đỏ/vàng/xanh nằm ở rate().
  function analyze(input, index) {
    var p = parseHost(input);
    var host = p.raw.replace(/^www\./, '');
    var nonAscii = hasNonAscii(host) || p.ascii.indexOf('xn--') !== -1;
    var base = { host: p.raw, ascii: p.ascii, nonAscii: nonAscii, latin: toLatin(host), matches: [], canonical: null };

    // Khớp chính xác hoặc là subdomain thật của tên miền tham chiếu.
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join('.');
      if (index.set.has(suffix)) { base.canonical = suffix; return base; }
    }

    var reg = registrable(host), brand = reg.split('.')[0], bsk = skeleton(brand);
    var cacheSk = {};
    index.list.forEach(function (t) {
      // 1) Trùng hình dạng toàn bộ tên miền (cùng số nhãn).
      var part = cacheSk[t.labels] || (cacheSk[t.labels] = { v: skeleton(lastLabels(host, t.labels)) });
      if (part.v === t.sk) {
        if (nonAscii || t.brand.length >= 4) base.matches.push({ domain: t.domain, type: 'visual' });
        return;
      }
      // 2) So theo tên thương hiệu, bỏ qua đuôi: bắt được vietc0mbank.com giả vietcombank.com.vn.
      if (t.brand.length < MIN_BRAND_LEN || t.reg === reg) return;
      if (bsk === t.bsk) {
        if (brand !== t.brand) base.matches.push({ domain: t.domain, type: 'visual' });          // khác nhau chỉ do ký tự giả dạng
        else if (FLAG_SAME_BRAND_OTHER_TLD) base.matches.push({ domain: t.domain, type: 'sameBrand' }); // cùng tên, khác đuôi
      } else if (distance(bsk, t.bsk) === 1) {
        base.matches.push({ domain: t.domain, type: 'edit' });
      }
    });
    var order = { visual: 0, sameBrand: 1, edit: 2 };
    base.matches.sort(function (a, b) { return order[a.type] - order[b.type]; });
    base.matches = base.matches.slice(0, 5);
    return base;
  }

  // Xếp mức rủi ro. lookup: null (không tra cứu) | 'found' | 'missing' | 'unknown'.
  //  red    = nguy cơ cao: trùng hình dạng với tên miền tham chiếu, hoặc tên miền Latin tương ứng đang tồn tại
  //  yellow = bất thường nhưng chưa đủ để đánh giá nguy cơ cao
  //  green  = chưa tìm thấy dấu hiệu bất thường (KHÔNG khẳng định an toàn)
  function rate(r, lookup, latinName) {
    var reasons = [], level = 'green';
    var of = function (t) { return r.matches.filter(function (m) { return m.type === t; }); };
    var visual = of('visual'), same = of('sameBrand'), edit = of('edit');

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
      if (same.length) {
        level = 'yellow';
        reasons.push('Cùng tên thương hiệu với ' + same[0].domain + ' nhưng khác đuôi tên miền. Có thể là website khác của cùng thương hiệu, cũng có thể là giả mạo.');
      }
      if (edit.length) {
        level = 'yellow';
        reasons.push('Tên thương hiệu chỉ khác 1 ký tự so với ' + edit[0].domain + ' (có thể là lỗi đánh máy hoặc cố tình bắt chước).');
      }
    }
    return { level: level, reasons: reasons };
  }

  var api = { skeleton: skeleton, toLatin: toLatin, distance: distance, parseHost: parseHost, registrable: registrable,
              buildIndex: buildIndex, analyze: analyze, rate: rate, hasNonAscii: hasNonAscii };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DomainGuard = api;
})(this);
