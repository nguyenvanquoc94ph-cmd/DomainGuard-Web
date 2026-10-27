// Kiểm thử luật thương hiệu + bảng quyết định màu (offline): node test/brand.test.js
'use strict';
const assert = require('assert');
const DG = require('../public/detector.js');
const cr = DG.compileBrandRules(require('../public/brand_rules.json'));
const idx = DG.buildIndex(['facebook.com', 'vietcombank.com.vn', 'google.com', 'amazon.com', 'paypal.com', 'microsoft.com', 'shopee.vn',
  'tiktok.com', 'vnexpress.net', 'acb.com.vn', 'binance.com', 'agoda.com', 'popular-facebook-fans.com']);
const run = (d, x) => DG.decide(Object.assign({ r: DG.analyze(d, idx, cr), rules: cr }, x || {}));
const expect = (d, level, x) => { const o = run(d, x); assert.strictEqual(o.level, level, d + ': mong đợi ' + level + ', nhận ' + o.level + ' | ' + o.reasons.join(' / ')); return o; };

// 1) Báo nhầm đã phát hiện ở bản v0.7 -> phải XANH
['youtube-nocookie.com', 'amazon-adsystem.com', 'paypal-community.com', 'microsoftonline-p.com', 'twister-game.com', 'vietnet.vn', 'mbank.pl',
 'shopee.co.id', 'lazada.co.th', 'apple-pie-recipes.com', 'pineapple.com', 'acbhome.com', 'finance-news.com', 'pagoda-travel.com', 'vibe-music.com',
 'seven-eleven.com', 'vincomputer.com', 'event-hanoi.vn', 'metal-shop.com', 'myoutlook.com', 'canvas-art.com', 'booking-hotel.com',
 'myproject.github.io', 'docs.github.com', 'm.facebook.com', 'fb.com', 'google.com.vn', 'mail.google.co.uk', 'vnexpress.net'
].forEach((d) => expect(d, 'green'));
// 2) Dấu hiệu thương hiệu yếu, nhóm không nhạy cảm -> xanh + ghi chú
['tiktok-shop.vn', 'google-ads-tips.com', 'netflix-review.net'].forEach((d) => { const o = expect(d, 'green'); assert.strictEqual(o.brandLevel, 'note', d); });
// 3) Tên miền phổ biến chứa thương hiệu -> chỉ ghi chú
assert.strictEqual(expect('popular-facebook-fans.com', 'green').brandLevel, 'note');
// 4) Vàng: thương hiệu mạnh chưa có tín hiệu thêm, hoặc yếu nhưng thuộc ngân hàng/ví/nhà nước
['facebook-login.com', 'facebook.com.login-verify.xyz', 'facebook-com-secure.net', 'vietcombank-xacthuc.com', 'vietcombankonline.net',
 'faceb00k-secure.com', 'faceboook-login.com', 'apple-id-verify.net', 'acb-otp.com', 'mbbank-login.vn', 'vpbank-dangnhap.com',
 'zalo-xacminh.com', 'outlook-verify.com', 'vietcombank-login.github.io', 'facebook-verify.vercel.app', 'vietcombank-tet2027.com', 'vietcombank.com'
].forEach((d) => expect(d, 'yellow'));
assert.strictEqual(run('facebook-login.com').title, 'KHÔNG PHẢI WEBSITE CHÍNH THỨC');
assert.strictEqual(run('vietcombank-tet2027.com').brand.strength, 'weak');
// 5) Đỏ: thương hiệu mạnh + tín hiệu thêm
expect('facebook-login.com', 'red', { createdDays: 3 });
expect('facebook-login.com', 'red', { community: { count: 3 } });
expect('facebook-login.com', 'yellow', { community: { count: 1 } });
expect('vietcombank-tet2027.com', 'yellow', { createdDays: 3 });   // dấu hiệu yếu: tên miền mới cũng không lên đỏ
// 6) Danh sách đen theo mức nguồn
const blStrong = { listed: true, strong: true, matches: [{ type: 'host' }], sources: [{ id: 'openphish', name: 'OpenPhish', category: 'phishing', tier: 'high', categoryLabel: 'lừa đảo' }] };
const blWeak = { listed: true, strong: false, matches: [{ type: 'host' }], sources: [{ id: 'phishingDatabase', name: 'Phishing.Database', category: 'phishing', tier: 'low', categoryLabel: 'lừa đảo' }] };
assert.strictEqual(expect('random-site.xyz', 'red', { blacklist: blStrong }).title, 'ĐÃ BỊ GẮN CỜ NGUY HIỂM');
assert.strictEqual(expect('random-site.xyz', 'yellow', { blacklist: blWeak }).title, 'CÓ TRONG DANH SÁCH ĐÁNG NGỜ');
expect('facebook-login.com', 'red', { blacklist: blWeak });   // thương hiệu mạnh + bất kỳ danh sách đen nào
// 7) Giả dạng ký tự vẫn đỏ
assert.strictEqual(expect('faceb00k.com', 'red').title, 'NGUY CƠ CAO WEBSITE GIẢ MẠO');
// 8) Chế độ log: không cảnh báo thương hiệu nhưng đánh dấu để ghi log
const lg = run('facebook-login.com', { mode: 'log' });
assert.ok(lg.level === 'green' && lg.brandLogged);
// 9) Allowlist bỏ cảnh báo dựa trên tên, nhưng vẫn giữ danh sách đen
expect('facebook-login.com', 'green', { allowlisted: true });
expect('facebook-login.com', 'red', { allowlisted: true, blacklist: blStrong });
// 10) Không dùng chữ "giả mạo" cho cảnh báo thương hiệu
assert.ok(!/giả mạo/i.test(run('facebook-login.com', { createdDays: 1 }).title));
console.log('brand.test.js: OK');
