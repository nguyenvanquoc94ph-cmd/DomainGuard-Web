(function () {
  'use strict';
  var DG = window.DomainGuard;
  var $ = function (id) { return document.getElementById(id); };

  // Danh sách thương hiệu bảo vệ tích hợp sẵn: luôn được dùng, kể cả khi Tranco/Cloudflare không trả về.
  // Viết tay, cần rà soát lại trước khi dùng thật.
  var BUILTIN = [
    'vietcombank.com.vn','bidv.com.vn','vietinbank.vn','agribank.com.vn','techcombank.com','mbbank.com.vn','vpbank.com.vn','acb.com.vn','sacombank.com.vn',
    'tpbank.com.vn','hdbank.com.vn','vib.com.vn','shb.com.vn','ocb.com.vn','msb.com.vn','seabank.com.vn','scb.com.vn','eximbank.com.vn','lpbank.com.vn',
    'momo.vn','zalopay.vn','zalo.me','shopee.vn','lazada.vn','tiki.vn','sendo.vn','grab.com',
    'vnexpress.net','dantri.com.vn','tuoitre.vn','thanhnien.vn','vietnamnet.vn','dichvucong.gov.vn','vnpost.vn',
    'viettel.vn','vnpt.vn','mobifone.vn','evn.com.vn','fpt.com','fpt.vn','fpt-software.com',
    'amazon.com','google.com','microsoft.com','apple.com','paypal.com','facebook.com','instagram.com','github.com','linkedin.com','netflix.com',
    'youtube.com','outlook.com','office.com','dropbox.com','ebay.com','whatsapp.com','telegram.org','tiktok.com','twitter.com','binance.com'
  ];

  var index = DG.buildIndex(BUILTIN);
  var community = { enabled:false, auth:null, db:null, user:null };
  var REASONS = { impersonation:'Giả mạo thương hiệu/ngân hàng', credential_theft:'Thu thập tài khoản, mật khẩu hoặc OTP', investment_scam:'Lừa đảo đầu tư/chuyển tiền', malware:'Phát tán mã độc hoặc file nguy hiểm', other:'Lý do khác' };

  var LEVELS = {
    red:    { cls: 'risk-red',    icon: '🚨', title: 'NGUY CƠ CAO WEBSITE GIẢ MẠO',
              msg: 'Tên miền có dấu hiệu cố tình bắt chước một thương hiệu hoặc website phổ biến. Không nên nhập mật khẩu, mã OTP hoặc thông tin thanh toán cho tới khi xác minh được website.' },
    yellow: { cls: 'risk-yellow', icon: '⚠️', title: 'CẦN KIỂM TRA THÊM',
              msg: 'Đã phát hiện dấu hiệu bất thường hoặc có báo cáo từ cộng đồng. Hãy thận trọng trước khi truy cập.' },
    green:  { cls: 'risk-green',  icon: '✅', title: 'CHƯA TÌM THẤY DẤU HIỆU BẤT THƯỜNG',
              msg: 'Chưa phát hiện tên miền tương tự, ký tự giả dạng Latin hoặc báo cáo từ cộng đồng.' }
  };
  var TYPE_LABEL = { visual: 'trùng hình dạng', sameBrand: 'cùng tên, khác đuôi', edit: 'khác 1 ký tự' };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text).normalize('NFC'); return e; }

  function normalizeVietnamese(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = walker.nextNode())) { var v = n.nodeValue.normalize('NFC'); if (v !== n.nodeValue) n.nodeValue = v; }
    root.querySelectorAll('[placeholder],[aria-label],[title]').forEach(function (e) {
      ['placeholder', 'aria-label', 'title'].forEach(function (a) { var v = e.getAttribute(a); if (v) e.setAttribute(a, v.normalize('NFC')); });
    });
  }

  // ---- Ô nhập: nút xoá, nút dán, thông báo ngắn ----
  function setHint(text) { $('hint').textContent = text ? String(text).normalize('NFC') : ''; }
  function syncClear() { $('clear').hidden = !$('url').value; }

  function clearInput() {
    $('url').value = '';
    $('result').replaceChildren();   // xoá luôn kết quả cũ để không nhầm với địa chỉ mới
    setHint('');
    syncClear();
    $('url').focus();
  }

  async function pasteInput() {
    setHint('');
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
      var text = (await navigator.clipboard.readText()).trim();
      if (!text) { setHint('Bộ nhớ tạm đang trống. Hãy sao chép một liên kết trước.'); return; }
      $('url').value = text;
      syncClear();
      $('url').focus();
    } catch (e) {
      // Trình duyệt từ chối quyền, hoặc không hỗ trợ: chuyển sang cách dán thủ công.
      $('url').focus();
      setHint('Trình duyệt không cho dán tự động. Hãy nhấn giữ vào ô nhập rồi chọn "Dán".');
    }
  }

  // ---- Cuộn tới kết quả ----
  function scrollToResult() {
    var box = $('result');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Chờ trình duyệt dựng xong nội dung rồi mới cuộn.
    requestAnimationFrame(function () { box.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); });
  }

  async function loadDomains() {
    $('syncText').textContent = 'Đang tải danh sách...';
    try {
      var r = await fetch('/api/domains', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      index = DG.buildIndex(BUILTIN.concat(j.domains || []));
      var c = j.counts || {};
      var when = j.updatedAt ? new Date(j.updatedAt).toLocaleString('vi-VN') : 'chưa đồng bộ';
      var text = 'Đang dùng ' + index.list.length.toLocaleString('vi-VN') + ' tên miền · Tích hợp sẵn: ' + BUILTIN.length + ' · Cloudflare Radar Việt Nam: ' + (c.cloudflareVN || 0).toLocaleString('vi-VN') +
        ' · Tranco: ' + (c.tranco || 0).toLocaleString('vi-VN') + ' · Cập nhật: ' + when;
      if (j.errors && j.errors.length) text += ' · Lỗi: ' + j.errors.join('; ');
      $('syncText').textContent = text;
    } catch (e) {
      index = DG.buildIndex(BUILTIN);
      $('syncText').textContent = 'Không kết nối được máy chủ (/api/domains). Đang dùng ' + BUILTIN.length + ' tên miền tích hợp sẵn.';
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

  // ---------- Firebase Authentication + báo cáo cộng đồng ----------
  function firebaseConfigured() {
    var c = window.DOMAIN_GUARD_FIREBASE_CONFIG || {};
    return !!(c.apiKey && c.authDomain && c.databaseURL && c.projectId && c.appId && window.firebase);
  }
  function initCommunity() {
    if (!firebaseConfigured()) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.DOMAIN_GUARD_FIREBASE_CONFIG);
      community.auth=firebase.auth(); community.db=firebase.database(); community.enabled=true;
      community.auth.onAuthStateChanged(function(u){community.user=u||null;});
    } catch(e) { console.warn('Không khởi tạo được Firebase:',e.message); }
  }
  function base64Url(text) {
    var bytes=new TextEncoder().encode(text), binary='';
    bytes.forEach(function(b){binary+=String.fromCharCode(b);});
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
  }
  function reportDomain(r){return DG.registrable(String(r.ascii||r.host).replace(/^www\./,''));}
  function summarize(obj){
    var list=obj?Object.keys(obj).map(function(k){return obj[k];}).filter(Boolean):[], reasons={};
    list.forEach(function(x){if(x.reason&&REASONS[x.reason])reasons[x.reason]=(reasons[x.reason]||0)+1;});
    return {count:list.length,reasons:reasons};
  }
  async function getReports(domain) {
    if(!community.enabled)return {count:0,reasons:{},unavailable:true,mine:false};
    try{
      var snap=await community.db.ref('reports/'+base64Url(domain)).once('value'), obj=snap.val()||{}, x=summarize(obj);
      x.mine=!!(community.user&&obj[community.user.uid]);x.unavailable=false;return x;
    }catch(e){return {count:0,reasons:{},unavailable:true,mine:false};}
  }
  function addCommunity(parent,summary,domain){
    var card=el('div','community-box');
    if(summary.unavailable){card.append(el('div','community-title','🚩 Báo cáo cộng đồng'));card.append(el('p','muted','Tính năng báo cáo chưa được cấu hình hoặc hiện không truy cập được.'));}
    else if(summary.count){
      card.append(el('div','community-title','🚩 '+summary.count.toLocaleString('vi-VN')+' báo cáo từ cộng đồng'));
      var ks=Object.keys(summary.reasons).sort(function(a,b){return summary.reasons[b]-summary.reasons[a];});
      if(ks.length){var ul=el('ul','community-reasons');ks.forEach(function(k){ul.append(el('li',null,REASONS[k]+' ('+summary.reasons[k]+')'));});card.append(ul);}
      card.append(el('p','muted','Thông tin do người dùng gửi và chưa được DomainGuard xác minh độc lập.'));
    }else card.append(el('div','community-title','🚩 Chưa có báo cáo từ cộng đồng'));
    var btn=el('button','report-btn',summary.mine?'✓ Bạn đã báo cáo tên miền này':'🚩 Báo cáo đáng ngờ');
    btn.type='button';btn.disabled=summary.mine||summary.unavailable;btn.addEventListener('click',function(){openReport(domain);});card.append(btn);parent.append(card);
  }
  function openReport(domain){$('reportDomain').textContent=domain;$('reportReason').value='';$('reportError').textContent='';$('reportModal').hidden=false;$('reportReason').focus();}
  function closeReport(){$('reportModal').hidden=true;$('reportError').textContent='';}
  async function ensureGoogleUser(){
    if(!community.enabled)throw new Error('Tính năng báo cáo chưa được cấu hình.');
    if(community.auth.currentUser)return community.auth.currentUser;
    var provider=new firebase.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
    try{return (await community.auth.signInWithPopup(provider)).user;}
    catch(e){
      if(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment'){await community.auth.signInWithRedirect(provider);throw new Error('Đang chuyển sang Google để đăng nhập.');}
      if(e.code==='auth/popup-closed-by-user'||e.code==='auth/cancelled-popup-request')throw new Error('Bạn đã đóng cửa sổ đăng nhập.');
      throw new Error('Không đăng nhập được bằng Google.');
    }
  }
  async function submitReport(){
    var domain=$('reportDomain').textContent,reason=$('reportReason').value;
    if(!REASONS[reason]){$('reportError').textContent='Vui lòng chọn lý do báo cáo.';return;}
    $('submitReport').disabled=true;$('reportError').textContent='';
    try{
      var user=await ensureGoogleUser(),ref=community.db.ref('reports/'+base64Url(domain)+'/'+user.uid),existing=await ref.once('value');
      if(existing.exists()){$('reportError').textContent='Bạn đã báo cáo tên miền này trước đó.';return;}
      await ref.set({uid:user.uid,domain:domain,reason:reason,createdAt:firebase.database.ServerValue.TIMESTAMP});closeReport();await check($('url').value,true);
    }catch(e){$('reportError').textContent=e.message||'Không gửi được báo cáo.';}finally{$('submitReport').disabled=false;}
  }

  async function check(value,preserveScroll) {
    var input=value!=null?value:$('url').value;$('url').value=input;syncClear();setHint('');$('url').blur();
    var box=$('result');box.replaceChildren(el('div','card muted','Đang kiểm tra...'));$('scan').disabled=true;if(!preserveScroll)scrollToResult();
    try{
      var r=DG.analyze(input,index),lookup=null,latinName=null;
      var needLookup=r.nonAscii&&r.latin!==r.host&&/^[a-z0-9.-]+$/.test(r.latin)&&!r.matches.some(function(m){return m.type==='visual';});
      if(needLookup){latinName=DG.registrable(r.latin);lookup=await dnsLookup(latinName);}
      var rating=DG.rate(r,lookup,latinName),domain=reportDomain(r),reports=await getReports(domain);
      var finalLevel=rating.level==='red'?'red':reports.count>0?'yellow':rating.level,L=LEVELS[finalLevel];
      var head=el('div','card '+L.cls);head.append(el('h2',null,L.icon+' '+L.title));
      head.append(el('div','msg',reports.count>0&&rating.level==='green'?'Không phát hiện dấu hiệu giả dạng tên miền, nhưng đã có '+reports.count+' báo cáo từ cộng đồng.':L.msg));
      if(rating.reasons.length){var ul=el('ul','reasons');rating.reasons.forEach(function(t){ul.append(el('li',null,t));});head.append(ul);}addCommunity(head,reports,domain);
      var detail=el('div','card');detail.append(el('h3',null,'Chi tiết phân tích'));var grid=el('div','grid');
      [['Tên miền đầu vào',r.host],['Dạng ASCII (Punycode) của trình duyệt',r.ascii],['Dạng Latin chuyển đổi',r.latin],['Ký tự ngoài Latin',r.nonAscii?'Có':'Không'],['Tra cứu DNS tên miền Latin'+(latinName?' ('+latinName+')':''),lookup===null?'Không cần tra cứu':lookup==='found'?'Có tồn tại':lookup==='missing'?'Không tồn tại':'Không xác minh được']].forEach(function(x){var c=el('div');c.append(el('div','label',x[0]),el('div','val',x[1]));grid.append(c);});detail.append(grid);
      if(r.matches.length){detail.append(el('div','label','Tên miền tham chiếu tương tự'));r.matches.forEach(function(m){detail.append(el('span','tag',m.domain+' · '+TYPE_LABEL[m.type]));});}
      if(r.canonical)detail.append(el('p','muted','Tên miền thuộc '+r.canonical+' trong danh sách tham chiếu (danh sách dựa trên độ phổ biến, không chứng nhận an toàn).'));
      box.replaceChildren(head,detail);
    }catch(e){box.replaceChildren(el('div','card risk-yellow',e.message));}
    finally{$('scan').disabled=false;if(!preserveScroll)scrollToResult();}
  }

  normalizeVietnamese(document.body);
  document.title = document.title.normalize('NFC');
  initCommunity();
  $('scan').addEventListener('click', function () { check(); });
  $('paste').addEventListener('click', pasteInput);
  $('clear').addEventListener('click', clearInput);
  $('url').addEventListener('input', syncClear);
  $('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
  $('resync').addEventListener('click', loadDomains);
  $('closeReport').addEventListener('click',closeReport);
  $('cancelReport').addEventListener('click',closeReport);
  $('submitReport').addEventListener('click',submitReport);
  $('reportModal').addEventListener('click',function(e){if(e.target===$('reportModal'))closeReport();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('reportModal').hidden)closeReport();});
  document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { check(b.dataset.v); }); });
  syncClear();
  loadDomains();
})();
