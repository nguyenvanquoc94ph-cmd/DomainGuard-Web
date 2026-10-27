// Kiểm thử blacklist offline: node test/blacklist.test.js
'use strict';
const assert = require('assert');
const os = require('os'), path = require('path');
const DG = require('../public/detector.js');
const { createBlacklist } = require('../blacklist.js');
const official = new Set(['google.com', 'facebook.com', 'vietcombank.com.vn']);
const popular = new Set(['popularsite.com', 'bigblog.net']);
const suf = (set) => (h) => { const p = h.split('.'); for (let i = 0; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return true; return false; };
const BL = createBlacklist({ dataDir: path.join(os.tmpdir(), 'dg-test'), registrable: DG.registrable, isOfficial: suf(official), isPopular: suf(popular), log: { log() {}, warn() {} } });
BL._setFeed('openphish', BL.parseFeed('openphish', ['https://faceboook-login.com/auth', 'https://sites.google.com/view/vcb-xacminh', 'https://evil.github.io/login/',
  'http://1.2.3.4/x', 'https://facebook.com/some/bad/page', 'https://bigblog.net/phish'].join('\n')));
BL._setFeed('phishingDatabase', BL.parseFeed('phishingDatabase', ['vietc0mbank-online.net', 'com', 'github.io', '# comment', 'popularsite.com', 'bigblog.net', 'faceboook-login.com'].join('\n')));
const t = (u) => BL.check(u);
assert.ok(t('faceboook-login.com').listed && t('faceboook-login.com').strong, 'OpenPhish + PhishingDB -> mạnh');
assert.ok(t('https://abc.faceboook-login.com/xyz').listed);
const weak = t('https://www.vietc0mbank-online.net');
assert.ok(weak.listed && !weak.strong, 'chỉ Phishing.Database -> yếu');
assert.ok(t('https://sites.google.com/view/vcb-xacminh').listed, 'URL chính xác trên dịch vụ dùng chung');
assert.ok(!t('https://sites.google.com/view/khac').listed);
assert.ok(!t('https://other.github.io').listed);
assert.ok(t('https://evil.github.io/login').listed);
assert.ok(!t('https://facebook.com').listed, 'tên miền chính thức: không khớp theo host');
assert.ok(t('https://facebook.com/some/bad/page').listed, 'tên miền chính thức: vẫn khớp URL chính xác');
assert.ok(!t('popularsite.com').listed, 'phổ biến + chỉ 1 nguồn -> bỏ qua');
assert.ok(t('bigblog.net').listed, 'phổ biến + 2 nguồn -> vẫn cảnh báo (không còn tin tuyệt đối)');
assert.ok(!t('google.com').listed && !t('example.com').listed);
assert.ok(t('http://1.2.3.4/abc').listed);
console.log('blacklist.test.js: OK');
