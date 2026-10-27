// Kiểm thử blacklist offline (không tải mạng): node test/blacklist.test.js
'use strict';
const assert = require('assert');
const os = require('os'), path = require('path');
const DG = require('../public/detector.js');
const { createBlacklist } = require('../blacklist.js');
const trusted = DG.buildIndex(['google.com', 'facebook.com', 'vietcombank.com.vn']);
const isTrusted = (h) => { const p = h.split('.'); for (let i = 0; i < p.length - 1; i++) if (trusted.set.has(p.slice(i).join('.'))) return true; return false; };
const BL = createBlacklist({ dataDir: path.join(os.tmpdir(), 'dg-test'), registrable: DG.registrable, isTrusted: isTrusted, log: { log() {}, warn() {} } });

BL._setFeed('openphish', BL.parseFeed('openphish', [
  'https://faceboook-login.com/auth', 'https://sites.google.com/view/vcb-xacminh', 'https://evil.github.io/login/', 'http://1.2.3.4/x'
].join('\n')));
BL._setFeed('phishingDatabase', BL.parseFeed('phishingDatabase', ['vietc0mbank-online.net', 'com', 'github.io', '# comment'].join('\n')));

const t = (u) => BL.check(u);
assert.ok(t('faceboook-login.com').listed, 'host trong OpenPhish');
assert.ok(t('https://abc.faceboook-login.com/xyz').listed, 'subdomain của host bị liệt kê');
assert.ok(t('https://www.vietc0mbank-online.net').listed, 'Phishing.Database');
assert.ok(t('https://sites.google.com/view/vcb-xacminh').listed, 'URL chính xác trên dịch vụ dùng chung');
assert.ok(!t('https://sites.google.com/view/khac').listed, 'không gắn cờ cả sites.google.com');
assert.ok(!t('https://other.github.io').listed, 'không gắn cờ cả github.io');
assert.ok(t('https://evil.github.io/login').listed, 'URL github.io cụ thể');
assert.ok(!t('google.com').listed && !t('example.com').listed, 'tên miền sạch');
assert.ok(t('http://1.2.3.4/abc').listed, 'IP');
assert.deepStrictEqual(t('faceboook-login.com').sources.map((s) => s.id), ['openphish']);
console.log('blacklist.test.js: OK');
