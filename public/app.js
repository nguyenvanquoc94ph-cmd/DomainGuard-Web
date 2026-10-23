(function () {
  'use strict';
  var DG = window.DomainGuard;
  var index = DG.buildIndex([]);
  var $ = function (id) { return document.getElementById(id); };

  // Chuẩn hoá NFC toàn bộ văn bản tiếng Việt trên trang (sửa lỗi dấu bị tách: "kê´t" -> "kết").
  function normalizeVietnamese(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var n; while ((n = walker.nextNode())) { var v = n.nodeValue.normalize('NFC'); if (v !== n.nodeValue) n.nodeValue = v; }
    root.querySelectorAll('[placeholder],[aria-label]').forEach(function (el) {
      ['placeholder', 'aria-label'].forEach(function (a) { var v = el.getAttribute(a); if (v) el.setAttribute(a, v.normalize('NFC')); });
    });
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text).normalize('NFC'); return e; }

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
      $('syncText').textContent = 'Không kết nối được máy chủ (/api/domains). Hãy chạy website bằng "node server.js".';
    }
  }

  var SLD = ['com','net','org','edu','gov','co','ac','or','ne','go'];
  function registrable(host) {
    var p = host.split('.');
    if (p.length >= 3 && p[p.length - 1].length === 2 && SLD.indexOf(p[p.length - 2]) !== -1) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
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
      // Tên miền có thể đăng ký (xấp xỉ, chưa dùng Public Suffix List): có hậu tố 2 cấp như com.vn thì lấy 3 nhãn cuối.
      var lookup = null, lookupName = null;
      if (r.nonAscii && r.latin !== r.host && /^[a-z0-9.-]+$/.test(r.latin)) {
        lookupName = registrable(r.latin);
        lookup = await dnsLookup(lookupName);
      }
      var warnings = [], notes = [];
      if (r.matches.length) warnings.push('Tên miền giống hoặc gần giống tên miền trong danh sách tham chiếu.');
      if (lookup === 'found') warnings.push('Tên miền Latin sau chuyển đổi (' + lookupName + ') đang tồn tại: có 2 tên miền trông gần như giống nhau.');
      if (r.nonAscii && !warnings.length) {
        if (lookup === 'missing') notes.push('Có ký tự ngoài bảng chữ Latin, nhưng không tìm thấy tên miền Latin tương ứng (' + lookupName + '), nên chưa cảnh báo.');
        else if (lookup === 'unknown') notes.push('Có ký tự ngoài bảng chữ Latin nhưng không tra cứu được tên miền Latin tương ứng. Hãy kiểm tra lại sau.');
        else notes.push('Có ký tự ngoài bảng chữ Latin nhưng không chuyển được sang tên miền Latin để so sánh.');
      }

      var status = warnings.length ? 'warn' : (r.status === 'known' && !r.nonAscii) ? 'known' : (r.nonAscii && lookup !== 'missing') ? 'known' : 'ok';
      var head = el('div', 'card ' + status);
      var title = status === 'warn' ? '⚠️ Cảnh báo: website có thể là giả mạo'
        : (r.status === 'known' && !r.nonAscii) ? 'ℹ️ Tên miền có trong danh sách tham chiếu'
        : (r.nonAscii && lookup !== 'missing') ? 'ℹ️ Chưa kết luận được'
        : r.nonAscii ? '✅ Chưa phát hiện tên miền Latin tương tự' : '✅ Chưa phát hiện dấu hiệu tương tự';
      head.append(el('h2', null, title));
      head.append(el('div', 'muted', status === 'warn' ? 'Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán khi chưa xác minh.' :
        (r.status === 'known' && !r.nonAscii) ? 'Khớp ' + r.canonical + '. Danh sách dựa trên độ phổ biến, không chứng nhận website an toàn.' : 'Kết quả này KHÔNG khẳng định website an toàn.'));
      warnings.forEach(function (w) { head.append(el('div', null, '• ' + w)); });
      notes.forEach(function (n) { head.append(el('div', 'muted', '• ' + n)); });

      var detail = el('div', 'card');
      detail.append(el('h3', null, 'Chi tiết phân tích'));
      var grid = el('div', 'grid');
      [['Tên miền đầu vào', r.host], ['Dạng ASCII (Punycode) của trình duyệt', r.ascii], ['Dạng Latin chuyển đổi', r.latin], ['Ký tự ngoài Latin', r.nonAscii ? 'Có' : 'Không'],
       ['Tra cứu DNS tên miền Latin' + (lookupName ? ' (' + lookupName + ')' : ''), lookup === null ? 'Không cần tra cứu' : lookup === 'found' ? 'Có tồn tại' : lookup === 'missing' ? 'Không tồn tại' : 'Không xác minh được']]
        .forEach(function (x) { var c = el('div'); c.append(el('div', 'label', x[0]), el('div', 'val', x[1])); grid.append(c); });
      detail.append(grid);
      if (r.matches.length) {
        detail.append(el('div', 'label', 'Tên miền tham chiếu tương tự'));
        r.matches.forEach(function (m) { detail.append(el('span', 'tag', m.domain + ' · ' + (m.type === 'visual' ? 'trùng hình dạng' : 'khác 1 ký tự'))); });
      }
      box.replaceChildren(head, detail);
    } catch (e) {
      box.replaceChildren(el('div', 'card warn', e.message));
    } finally { $('scan').disabled = false; }
  }

  normalizeVietnamese(document.body);
  document.title = document.title.normalize('NFC');
  $('scan').addEventListener('click', function () { check(); });
  $('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
  $('resync').addEventListener('click', loadDomains);
  document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { check(b.dataset.v); }); });
  loadDomains();
})();
