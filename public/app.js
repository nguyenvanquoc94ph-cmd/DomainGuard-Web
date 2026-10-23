(function () {
  'use strict';
  var DG = window.DomainGuard;
  var index = DG.buildIndex([]);
  var $ = function (id) { return document.getElementById(id); };

  // Giao diện 3 mức: đỏ / vàng / xanh (không còn màu xám).
  var LEVELS = {
    red:    { cls: 'risk-red',    icon: '🚨', title: 'NGUY CƠ CAO WEBSITE GIẢ MẠO',
              msg: 'Tên miền có dấu hiệu cố tình bắt chước một thương hiệu hoặc website phổ biến. Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán cho tới khi xác minh được website.' },
    yellow: { cls: 'risk-yellow', icon: '⚠️', title: 'CẦN KIỂM TRA THÊM',
              msg: 'Đã phát hiện dấu hiệu bất thường, nhưng chưa đủ dữ liệu để đánh giá đây là website giả mạo.' },
    green:  { cls: 'risk-green',  icon: '✅', title: 'CHƯA TÌM THẤY DẤU HIỆU BẤT THƯỜNG',
              msg: 'Chưa phát hiện tên miền tương tự hay ký tự giả dạng Latin. Kết quả này KHÔNG kết luận website an toàn hay không an toàn.' }
  };

  var SLD = ['com','net','org','edu','gov','co','ac','or','ne','go'];
  // Tên miền có thể đăng ký (xấp xỉ): hậu tố hai cấp như com.vn thì lấy 3 nhãn cuối.
  function registrable(host) {
    var p = host.split('.');
    if (p.length >= 3 && p[p.length - 1].length === 2 && SLD.indexOf(p[p.length - 2]) !== -1) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text).normalize('NFC'); return e; }

  function normalizeVietnamese(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = walker.nextNode())) { var v = n.nodeValue.normalize('NFC'); if (v !== n.nodeValue) n.nodeValue = v; }
    root.querySelectorAll('[placeholder],[aria-label]').forEach(function (e) {
      ['placeholder', 'aria-label'].forEach(function (a) { var v = e.getAttribute(a); if (v) e.setAttribute(a, v.normalize('NFC')); });
    });
  }

  async function loadDomains() {
    $('syncText').textContent = 'Đang tải danh sách...';
    try {
      var r = await fetch('/api/domains', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      index = DG.buildIndex(j.domains || []);
      var c = j.counts || {};
      var when = j.updatedAt ? new Date(j.updatedAt).toLocaleString('vi-VN') : 'chưa đồng bộ';
      var text = 'Đang dùng ' + index.list.length.toLocaleString('vi-VN') + ' tên miền · Cloudflare Radar Việt Nam: ' + (c.cloudflareVN || 0).toLocaleString('vi-VN') +
        ' · Tranco: ' + (c.tranco || 0).toLocaleString('vi-VN') + ' · Mẫu: ' + (c.base || 0) + ' · Cập nhật: ' + when;
      if (j.errors && j.errors.length) text += ' · Lỗi: ' + j.errors.join('; ');
      $('syncText').textContent = text;
    } catch (e) {
      $('syncText').textContent = 'Không kết nối được máy chủ (/api/domains).';
    }
  }

  async function dnsLookup(host) {
    try {
      var r = await fetch('https://dns.google/resolve?name=' + encodeURIComponent(host) + '&type=SOA', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return 'unknown';
      var j = await r.json();
      return j.Status === 0 ? 'found' : j.Status === 3 ? 'missing' : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  async function check(value) {
    var input = value != null ? value : $('url').value;
    $('url').value = input;
    var box = $('result'); box.replaceChildren(el('div', 'card muted', 'Đang kiểm tra...'));
    $('scan').disabled = true;
    try {
      var r = DG.analyze(input, index);
      var lookup = null, latinName = null;
      // Chỉ tra cứu DNS khi có ký tự lạ và chưa trùng hình dạng với tên miền tham chiếu (trùng thì đã là mức đỏ).
      var needLookup = r.nonAscii && r.latin !== r.host && /^[a-z0-9.-]+$/.test(r.latin) && !r.matches.some(function (m) { return m.type === 'visual'; });
      if (needLookup) { latinName = registrable(r.latin); lookup = await dnsLookup(latinName); }

      var rating = DG.rate(r, lookup, latinName);
      var L = LEVELS[rating.level];

      var head = el('div', 'card ' + L.cls);
      head.append(el('h2', null, L.icon + ' ' + L.title));
      head.append(el('div', 'msg', L.msg));
      if (rating.reasons.length) {
        var ul = el('ul', 'reasons');
        rating.reasons.forEach(function (t) { ul.append(el('li', null, t)); });
        head.append(ul);
      }

      var detail = el('div', 'card');
      detail.append(el('h3', null, 'Chi tiết phân tích'));
      var grid = el('div', 'grid');
      [['Tên miền đầu vào', r.host], ['Dạng ASCII (Punycode) của trình duyệt', r.ascii], ['Dạng Latin chuyển đổi', r.latin], ['Ký tự ngoài Latin', r.nonAscii ? 'Có' : 'Không'],
       ['Tra cứu DNS tên miền Latin' + (latinName ? ' (' + latinName + ')' : ''),
         lookup === null ? 'Không cần tra cứu' : lookup === 'found' ? 'Có tồn tại' : lookup === 'missing' ? 'Không tồn tại' : 'Không xác minh được']]
        .forEach(function (x) { var c = el('div'); c.append(el('div', 'label', x[0]), el('div', 'val', x[1])); grid.append(c); });
      detail.append(grid);
      if (r.matches.length) {
        detail.append(el('div', 'label', 'Tên miền tham chiếu tương tự'));
        r.matches.forEach(function (m) { detail.append(el('span', 'tag', m.domain + ' · ' + (m.type === 'visual' ? 'trùng hình dạng' : 'khác 1 ký tự'))); });
      }
      if (r.canonical) detail.append(el('p', 'muted', 'Tên miền thuộc ' + r.canonical + ' trong danh sách tham chiếu (danh sách dựa trên độ phổ biến, không chứng nhận an toàn).'));
      box.replaceChildren(head, detail);
    } catch (e) {
      box.replaceChildren(el('div', 'card risk-yellow', e.message));
    } finally { $('scan').disabled = false; }
  }

  normalizeVietnamese(document.body);
  $('scan').addEventListener('click', function () { check(); });
  $('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
  $('resync').addEventListener('click', loadDomains);
  document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { check(b.dataset.v); }); });
  loadDomains();
})();
