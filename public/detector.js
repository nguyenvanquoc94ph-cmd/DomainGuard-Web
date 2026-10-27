// DomainGuard detector v0.8 - dùng chung cho trình duyệt, máy chủ (bot Zalo) và kiểm thử.
// Mọi quyết định màu (đỏ/vàng/xanh) nằm ở decide(): web và bot gọi cùng một hàm.
(function (root) {
  'use strict';
  var FLAG_SAME_BRAND_OTHER_TLD = true;
  var MIN_BRAND_LEN = 5;
  var CONFUSABLE = {
    'а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','һ':'h','ԁ':'d','ӏ':'l','ԛ':'q','ԝ':'w','к':'k','м':'m','т':'t','в':'b','н':'h',
    'α':'a','ο':'o','ε':'e','ρ':'p','ν':'v','τ':'t','κ':'k','ι':'i','υ':'u','χ':'x',
    'ɑ':'a','ɡ':'g','ı':'i','ȷ':'j','ⅼ':'l','ℓ':'l'
  };
  var LATIN_SWAP = { '0':'o', '1':'l', '5':'s', '3':'e', '8':'b', '6':'b', '9':'g' };
  var SLD = ['com','net','org','edu','gov','co','ac','or','ne','go','info','biz'];
  function hasNonAscii(s) { return /[^\x00-\x7f]/.test(s); }
  function skeleton(s) {
    var out = Array.from(String(s).normalize('NFKC').toLowerCase())
      .map(function (c) { return CONFUSABLE[c] || LATIN_SWAP[c] || c; }).join('');
    return out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  }
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

  // ---------------- Bộ luật thương hiệu ----------------
  function compileBrandRules(rules) {
    if (!rules || !rules.brands) return null;
    var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    var keywords = (rules.keywords || []).map(norm).filter(Boolean);
    var stop = new Set((rules.stopwords || []).map(norm).concat(keywords));
    var brands = [], official = new Map(), skSet = new Set(), byKey = {};
    var sensitive = new Set(rules.sensitiveCategories || ['bank', 'payment', 'gov']);
    Object.keys(rules.brands).forEach(function (key) {
      var b = rules.brands[key];
      var off = (b.official || []).map(function (d) { return String(d).toLowerCase(); });
      off.forEach(function (d) { if (!official.has(d)) official.set(d, key); });
      byKey[key] = { name: b.name || key, category: b.category || '', official: off };
      [key].concat(b.aliases || []).map(norm).filter(Boolean).forEach(function (id) {
        var sk = skeleton(id); skSet.add(sk);
        brands.push({ key: key, name: b.name || key, id: id, sk: sk, strict: b.strict === true || id.length <= 4, official: off,
          category: b.category || '', sensitive: sensitive.has(b.category) });
      });
    });
    return {
      mode: rules.mode === 'log' ? 'log' : 'warn', version: rules.version || null,
      keywords: keywords, stop: stop, brands: brands, official: official, brandSk: skSet, byKey: byKey,
      shared: new Set((rules.sharedHosts || []).map(function (d) { return String(d).toLowerCase(); })),
      minEmbed: rules.minEmbedLength || 8, minNear: rules.minNearLength || 5, strongNear: rules.strongNearMinLength || 7,
      communityRed: rules.communityRedThreshold || 3, newDays: rules.newDomainDays || 30
    };
  }
  // Tên miền dùng chung (github.io, vercel.app...): ai cũng tạo được tên miền con.
  function sharedSuffix(host, cr) {
    var parts = host.split('.');
    for (var i = 1; i < parts.length - 1; i++) { var s = parts.slice(i).join('.'); if (cr.shared.has(s)) return s; }
    return null;
  }
  // Trả về khoá thương hiệu nếu host là tên miền chính thức (hoặc tên miền con của nó).
  function officialBrand(host, cr) {
    if (!cr || !host) return null;
    host = String(host).toLowerCase().replace(/^www\./, '');
    if (cr.official.has(host)) return cr.official.get(host);
    if (sharedSuffix(host, cr)) return null;
    var parts = host.split('.');
    for (var i = 1; i < parts.length - 1; i++) { var s = parts.slice(i).join('.'); if (cr.official.has(s)) return cr.official.get(s); }
    return null;
  }
  // Phát hiện tên miền mượn tên thương hiệu. strength: 'strong' | 'weak'.
  function detectBrandAbuse(host, cr) {
    if (!cr) return null;
    host = String(host).toLowerCase().replace(/^www\./, '');
    if (officialBrand(host, cr)) return null;
    var parts = host.split('.'), shared = sharedSuffix(host, cr), reg, suffixLen;
    if (shared) { suffixLen = shared.split('.').length; reg = parts.slice(parts.length - suffixLen - 1).join('.'); }
    else { reg = registrable(host); suffixLen = reg.split('.').length - 1; }
    var labels = parts.slice(0, parts.length - suffixLen), regIdx = labels.length - 1;
    var tokens = [], compacts = [];
    labels.forEach(function (l, li) {
      var c = l.replace(/-/g, '');
      compacts.push({ raw: c, sk: skeleton(c), li: li });
      l.split('-').forEach(function (t) { if (t) tokens.push({ raw: t, sk: skeleton(t), li: li }); });
    });
    var keyword = null;
    for (var k = 0; k < cr.keywords.length && !keyword; k++) {
      var kw = cr.keywords[k];
      if (tokens.some(function (t) { return t.raw === kw; })) keyword = kw;
      else if (kw.length >= 5 && compacts.some(function (c) { return c.raw.indexOf(kw) !== -1 && c.raw !== kw; })) keyword = kw;
    }
    var best = null, RANK = { exact: 4, lookalike: 3, embedded: 2, near: 1 };
    cr.brands.forEach(function (b) {
      var hit = null;
      var ex = tokens.filter(function (t) { return t.sk === b.sk; })[0];
      if (ex) hit = { type: ex.raw === b.id ? 'exact' : 'lookalike', li: ex.li, token: ex.raw };
      if (!hit && !b.strict) {
        var embedOk = b.id.length >= cr.minEmbed || (b.id.length >= 6 && keyword);
        var em = embedOk && compacts.filter(function (c) { return c.sk !== b.sk && c.sk.indexOf(b.sk) !== -1; })[0];
        if (em) hit = { type: 'embedded', li: em.li, token: em.raw };
      }
      // Lệch 1 ký tự: CHỈ xét khi có từ khoá nhạy cảm (tránh mbank.pl, vietnet.vn, twister-game.com).
      if (!hit && !b.strict && keyword && b.id.length >= cr.minNear) {
        var nr = tokens.filter(function (t) {
          return t.raw.length >= cr.minNear && !cr.stop.has(t.raw) && !cr.brandSk.has(t.sk) && distance(t.sk, b.sk) === 1;
        })[0];
        if (nr) hit = { type: 'near', li: nr.li, token: nr.raw };
      }
      if (!hit) return;
      if (b.strict && !keyword) return;
      // Chứa nguyên tên miền chính thức ở phần đầu: facebook.com.login-verify.xyz, facebook-com-secure.net
      var embedsOfficial = b.official.some(function (o) {
        if (hit.li < regIdx && (host.indexOf(o + '.') === 0 || host.indexOf('.' + o + '.') !== -1)) return true;
        var dashed = o.replace(/\./g, '-'), at = host.indexOf(dashed), end = at + dashed.length;
        return at !== -1 && (at === 0 || /[.-]/.test(host[at - 1])) && end < host.length && /[.-]/.test(host[end]);
      });
      var strong = embedsOfficial ||
        (keyword && hit.type !== 'near') ||
        (keyword && hit.type === 'near' && b.id.length >= cr.strongNear);
      var score = (strong ? 100 : 0) + RANK[hit.type] * 10 + (keyword ? 5 : 0) + b.id.length / 100;
      if (!best || score > best.score) best = {
        score: score, brand: b.key, name: b.name, category: b.category, sensitive: b.sensitive, matchType: hit.type, token: hit.token,
        keyword: keyword, inSubdomain: hit.li < regIdx, embedsOfficial: embedsOfficial, strength: strong ? 'strong' : 'weak',
        registrable: reg, official: b.official.slice(0, 6), officialCount: b.official.length
      };
    });
    if (best) delete best.score;
    return best;
  }

  // Dữ kiện thô (không quyết định màu).
  function analyze(input, index, cr) {
    var p = parseHost(input);
    var host = p.raw.replace(/^www\./, ''), asciiHost = p.ascii.replace(/^www\./, '');
    var nonAscii = hasNonAscii(host) || p.ascii.indexOf('xn--') !== -1;
    var base = { host: p.raw, ascii: p.ascii, nonAscii: nonAscii, latin: toLatin(host), matches: [], canonical: null, official: null, brand: null };
    if (cr && !nonAscii) base.official = officialBrand(asciiHost, cr);
    if (base.official) return base;     // tên miền chính thức: không so sánh tiếp
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join('.');
      if (index.set.has(suffix)) { base.canonical = suffix; break; }
    }
    if (!base.canonical) {
      var reg = registrable(host), brand = reg.split('.')[0], bsk = skeleton(brand), cacheSk = {};
      index.list.forEach(function (t) {
        var part = cacheSk[t.labels] || (cacheSk[t.labels] = { v: skeleton(lastLabels(host, t.labels)) });
        if (part.v === t.sk) {
          if (nonAscii || t.brand.length >= 4) base.matches.push({ domain: t.domain, type: 'visual' });
          return;
        }
        if (t.brand.length < MIN_BRAND_LEN || t.reg === reg) return;
        if (bsk === t.bsk) {
          if (brand !== t.brand) base.matches.push({ domain: t.domain, type: 'visual' });
          else if (FLAG_SAME_BRAND_OTHER_TLD) base.matches.push({ domain: t.domain, type: 'sameBrand' });
        } else if (distance(bsk, t.bsk) === 1) {
          base.matches.push({ domain: t.domain, type: 'edit' });
        }
      });
      var order = { visual: 0, sameBrand: 1, edit: 2 };
      base.matches.sort(function (a, b) { return order[a.type] - order[b.type]; });
      base.matches = base.matches.slice(0, 5);
    }
    // Tên miền phổ biến vẫn được xét thương hiệu, nhưng decide() chỉ ghi chú.
    if (cr) base.brand = detectBrandAbuse(nonAscii ? toLatin(host) : asciiHost, cr);
    return base;
  }

  function brandReason(bh) {
    var t = '"' + bh.token + '"', s;
    if (bh.matchType === 'near') s = 'Tên miền chứa ' + t + ', gần giống tên thương hiệu ' + bh.name;
    else if (bh.matchType === 'lookalike') s = 'Tên miền chứa ' + t + ', là tên thương hiệu ' + bh.name + ' viết thay ký tự';
    else if (bh.matchType === 'embedded') s = 'Tên miền chứa tên thương hiệu ' + bh.name + ' viết liền trong ' + t;
    else s = 'Tên miền chứa tên thương hiệu ' + bh.name;
    s += ', nhưng không thuộc các tên miền chính thức mà DomainGuard biết của thương hiệu này.';
    if (bh.keyword) s += ' Có kèm từ khoá thường gặp trong lừa đảo ("' + bh.keyword + '").';
    if (bh.inSubdomain) s += ' Tên thương hiệu nằm ở phần đầu (tên miền con); tên miền thật là ' + bh.registrable + '.';
    return s;
  }
  function blacklistReason(bl) {
    var names = (bl.sources || []).map(function (s) { return s.name + ' (' + s.categoryLabel + ')'; }).join(', ');
    var what = (bl.matches || []).some(function (m) { return m.type === 'host'; }) ? 'Tên miền' : 'Đường dẫn này';
    return what + ' nằm trong danh sách đen: ' + names + (bl.strong ? '.' : '. Mới có 1 nguồn cộng đồng ghi nhận, chưa được nguồn khác xác nhận.');
  }

  var RANK_LV = { green: 0, yellow: 1, red: 2 };
  var ADVICE = {
    red: 'Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán.',
    yellow: 'Chưa đủ dữ liệu để kết luận đây là website lừa đảo. Hãy kiểm tra kỹ trước khi nhập thông tin.',
    green: 'Kết quả này không kết luận website an toàn hay không.'
  };
  // Quyết định màu - DÙNG CHUNG cho web và bot.
  // s = { r, rules, mode, lookup, latinName, blacklist, community, createdDays, allowlisted }
  function decide(s) {
    var r = s.r, cr = s.rules || null, mode = s.mode || (cr && cr.mode) || 'warn';
    var bl = s.blacklist || { listed: false }, com = s.community || { count: 0 }, allow = !!s.allowlisted;
    var out = { level: 'green', kind: 'none', reasons: [], notes: [], brand: null, brandLevel: null, brandLogged: false };
    var up = function (lv, kind) { if (RANK_LV[lv] > RANK_LV[out.level]) { out.level = lv; out.kind = kind; } };
    var of = function (t) { return r.matches.filter(function (m) { return m.type === t; }); };
    var visual = allow ? [] : of('visual');

    // 1) Danh sách đen: nguồn mạnh (OpenPhish/URLhaus hoặc >= 2 nguồn) -> đỏ; chỉ Phishing.Database -> vàng.
    if (bl.listed) { up(bl.strong ? 'red' : 'yellow', 'blacklist'); out.reasons.push(blacklistReason(bl)); }
    // 2) Giả dạng ký tự
    if (visual.length) {
      up('red', 'spoof');
      out.reasons.push(r.nonAscii
        ? 'Tên miền dùng ký tự ngoài bảng chữ Latin nhưng trông giống hệt ' + visual[0].domain + '.'
        : 'Tên miền giả dạng ' + visual[0].domain + ' bằng cách thay hoặc ghép ký tự (ví dụ 0 thay o, rn thay m).');
    }
    if (r.nonAscii && !allow) {
      if (s.lookup === 'found') { up('red', 'spoof'); out.reasons.push('Sau khi chuyển sang Latin, tên miền ' + s.latinName + ' đang tồn tại: có 2 tên miền trông gần như giống nhau.'); }
      else if (!visual.length) {
        up('yellow', 'unicode');
        out.reasons.push('Tên miền chứa ký tự ngoài bảng chữ Latin.');
        if (s.lookup === 'missing') out.reasons.push('Không tìm thấy tên miền Latin tương ứng (' + s.latinName + ') để đối chiếu.');
        else if (s.lookup === 'unknown') out.reasons.push('Không tra cứu được tên miền Latin tương ứng, nên chưa đối chiếu được.');
      }
    }
    // 3) Lợi dụng thương hiệu
    var bh = r.brand;
    if (bh && !allow && !visual.length) {
      if (mode === 'log') out.brandLogged = true;
      else {
        out.brand = bh;
        if (r.canonical) {
          out.brandLevel = 'note';
          out.notes.push(brandReason(bh) + ' Tên miền này có trong danh sách website phổ biến nên chỉ ghi chú.');
        } else if (bh.strength === 'strong') {
          var extra = [];
          if (s.createdDays != null && s.createdDays >= 0 && s.createdDays < cr.newDays) extra.push('Tên miền mới đăng ký ' + Math.floor(s.createdDays) + ' ngày trước (dấu hiệu thường gặp ở website lừa đảo).');
          if (com.count >= cr.communityRed) extra.push('Đã có ' + com.count + ' báo cáo đáng ngờ từ cộng đồng.');
          if (bl.listed) extra.push('Đồng thời nằm trong danh sách đen.');
          out.brandLevel = extra.length ? 'red' : 'yellow';
          up(out.brandLevel, 'brand');
          out.reasons.push(brandReason(bh));
          out.reasons = out.reasons.concat(extra);
        } else if (bh.sensitive) {
          out.brandLevel = 'yellow'; up('yellow', 'brand'); out.reasons.push(brandReason(bh));
        } else {
          out.brandLevel = 'note'; out.notes.push(brandReason(bh));
        }
      }
    }
    // 4) Gần giống tên miền tham chiếu (bỏ trùng với cảnh báo thương hiệu)
    if (!allow) {
      var dup = function (m) { return out.brandLevel && out.brandLevel !== 'note' && cr && officialBrand(m.domain, cr) === bh.brand; };
      var same = of('sameBrand').filter(function (m) { return !dup(m); }), edit = of('edit').filter(function (m) { return !dup(m); });
      if (same.length) { up('yellow', 'similar'); out.reasons.push('Cùng tên với ' + same[0].domain + ' nhưng khác đuôi tên miền. Có thể là website khác của cùng thương hiệu, cũng có thể là giả mạo.'); }
      if (edit.length) { up('yellow', 'similar'); out.reasons.push('Tên chỉ khác 1 ký tự so với ' + edit[0].domain + ' (có thể là lỗi đánh máy hoặc cố tình bắt chước).'); }
    }
    // 5) Báo cáo cộng đồng
    if (com.count > 0) {
      up('yellow', 'community');
      if (!(out.brandLevel === 'red' && com.count >= (cr ? cr.communityRed : 3))) out.reasons.push('Tên miền đã nhận ' + com.count + ' báo cáo đáng ngờ từ cộng đồng.');
    }
    if (allow) out.notes.push('Tên miền đã được quản trị viên DomainGuard xác nhận, nên bỏ qua các cảnh báo dựa trên tên miền (danh sách đen vẫn được kiểm tra).');

    // Tiêu đề và thông điệp. Chỉ dùng chữ "giả mạo" khi có danh sách đen hoặc giả dạng ký tự.
    var name = out.brand ? out.brand.name : '';
    var T = {
      blacklist: { red: ['ĐÃ BỊ GẮN CỜ NGUY HIỂM', 'Địa chỉ này đã được nguồn bảo mật độc lập ghi nhận là ' + ((bl.sources || []).some(function (x) { return x.category === 'malware'; }) ? 'phát tán mã độc' : 'lừa đảo') + '. Không nên truy cập, nhập thông tin hay tải file từ trang này.'],
                   yellow: ['CÓ TRONG DANH SÁCH ĐÁNG NGỜ', 'Tên miền có trong danh sách lừa đảo do cộng đồng tổng hợp nhưng chưa được nguồn khác xác nhận. Hãy thận trọng trước khi truy cập.'] },
      spoof: { red: ['NGUY CƠ CAO WEBSITE GIẢ MẠO', 'Tên miền có dấu hiệu cố tình bắt chước một thương hiệu hoặc website phổ biến. Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán cho tới khi xác minh được website.'] },
      brand: { red: ['NGUY CƠ CAO – KHÔNG PHẢI WEBSITE CHÍNH THỨC', 'Tên miền dùng tên ' + name + ' nhưng không phải website chính thức, và có thêm dấu hiệu nguy hiểm. Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán.'],
               yellow: ['KHÔNG PHẢI WEBSITE CHÍNH THỨC', 'Tên miền dùng tên ' + name + ' nhưng không thuộc các website chính thức mà DomainGuard biết. Hãy kiểm tra kỹ trước khi nhập bất kỳ thông tin nào.'] }
    };
    var t = (T[out.kind] && T[out.kind][out.level]) ||
      (out.level === 'yellow' ? ['CẦN KIỂM TRA THÊM', 'Đã phát hiện dấu hiệu bất thường. Hãy thận trọng trước khi truy cập.'] :
       out.level === 'red' ? ['NGUY CƠ CAO', 'Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán.'] :
       ['CHƯA TÌM THẤY DẤU HIỆU BẤT THƯỜNG', 'Chưa phát hiện tên miền tương tự, ký tự giả dạng, dấu hiệu lợi dụng thương hiệu, danh sách đen hoặc báo cáo từ cộng đồng.']);
    out.title = t[0]; out.message = t[1]; out.advice = ADVICE[out.level];
    if (out.level === 'green') {
      var miss = [];
      if (s.blacklistUnavailable) miss.push('danh sách đen');
      if (com.unavailable) miss.push('báo cáo cộng đồng');
      if (!cr) miss.push('luật thương hiệu');
      if (miss.length) out.message = 'Chưa phát hiện dấu hiệu bất thường. Lưu ý: chưa kiểm tra được ' + miss.join(', ') + '.';
    }
    return out;
  }
  // Có cần tra RDAP (ngày đăng ký) không: chỉ khi dấu hiệu thương hiệu mạnh và có thể lên đỏ.
  function needsCreated(r, mode, allowlisted) {
    return !!(r.brand && r.brand.strength === 'strong' && !r.canonical && mode !== 'log' && !allowlisted);
  }
  function isAllowlisted(r, set) {
    if (!set || !set.size) return false;
    var h = String(r.ascii || r.host).replace(/^www\./, '');
    return set.has(h) || set.has(registrable(h));
  }

  var api = { skeleton: skeleton, toLatin: toLatin, distance: distance, parseHost: parseHost, registrable: registrable,
              buildIndex: buildIndex, analyze: analyze, hasNonAscii: hasNonAscii, decide: decide, needsCreated: needsCreated,
              isAllowlisted: isAllowlisted, compileBrandRules: compileBrandRules, detectBrandAbuse: detectBrandAbuse,
              officialBrand: officialBrand, brandReason: brandReason, blacklistReason: blacklistReason, ADVICE: ADVICE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DomainGuard = api;
})(this);
