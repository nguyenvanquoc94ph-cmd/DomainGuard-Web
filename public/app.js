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
  var lastChecked = null, checkSeq = 0;
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
  // ---- Thiết bị: ID ngẫu nhiên lưu trong trình duyệt, chỉ gửi bản băm SHA-256 lên Firebase ----
  function toHex(buf) { return Array.from(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function getDeviceId() {
    try {
      var k = 'dg_device_v1', v = localStorage.getItem(k);
      if (!v) { var a = new Uint8Array(24); crypto.getRandomValues(a); v = toHex(a); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return null; }
  }
  async function getDeviceKey() {
    var id = getDeviceId();
    if (!id) return null;
    if (window.crypto && crypto.subtle) return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dg|' + id)));
    return id;
  }
  function initCommunity() {
    if (!firebaseConfigured()) { updateAuthUi(); return; }
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.DOMAIN_GUARD_FIREBASE_CONFIG);
      community.auth=firebase.auth(); community.db=firebase.database(); community.enabled=true;
      community.auth.onAuthStateChanged(function(u){
        community.user=u||null; updateAuthUi();
        if (lastChecked) check(lastChecked,true);   // cập nhật lại nút báo cáo/thu hồi theo tài khoản hiện tại
      });
    } catch(e) { console.warn('Không khởi tạo được Firebase:',e.message); }
    updateAuthUi();
  }
  function updateAuthUi() {
    var box=$('authBox'); if(!box)return;
    box.hidden=!community.enabled;
    if(!community.enabled)return;
    var u=community.user;
    $('authText').textContent=u?('Đã đăng nhập: '+(u.displayName||u.email||'Google')):'Chưa đăng nhập';
    $('authBtn').textContent=u?'Đăng xuất':'Đăng nhập';
  }
  async function toggleAuth() {
    $('authBtn').disabled=true;
    try { if(community.user) await community.auth.signOut(); else await ensureGoogleUser(); }
    catch(e) { setHint(e.message||'Không đổi được trạng thái đăng nhập.'); }
    finally { $('authBtn').disabled=false; }
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
  // mine: tài khoản hiện tại đã báo cáo. blocked: thiết bị này đã dùng TÀI KHOẢN KHÁC báo cáo tên miền này.
  async function getReports(domain) {
    if(!community.enabled)return {count:0,reasons:{},unavailable:true,mine:false,blocked:false};
    try{
      var dk=base64Url(domain), snap=await community.db.ref('reports/'+dk).once('value'), obj=snap.val()||{}, x=summarize(obj);
      x.mine=!!(community.user&&obj[community.user.uid]); x.blocked=false; x.noDevice=false; x.unavailable=false;
      var key=await getDeviceKey();
      if(!key) x.noDevice=true;
      else if(!x.mine && community.user){
        var lock=(await community.db.ref('reportLocks/'+dk+'/'+key).once('value')).val();
        x.blocked=!!(lock && lock.uid!==community.user.uid);
      }
      return x;
    }catch(e){return {count:0,reasons:{},unavailable:true,mine:false,blocked:false};}
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
    var note=el('p','report-note');note.setAttribute('role','status');
    var btn=el('button','report-btn');btn.type='button';
    if(summary.mine){
      btn.textContent='↩ Thu hồi báo cáo của bạn';btn.classList.add('withdraw');
      btn.addEventListener('click',function(){withdrawReport(domain,btn,note);});
    }else if(summary.blocked){
      btn.textContent='🚫 Không thể báo cáo tên miền này';btn.disabled=true;
      note.textContent='Hiện chưa thể báo cáo tên miền này bằng tài khoản và thiết bị này.';
    }else if(summary.noDevice){
      btn.textContent='🚩 Báo cáo đáng ngờ';btn.disabled=true;
      note.textContent='Không xác định được thiết bị (trình duyệt đang chặn lưu dữ liệu), nên chưa thể báo cáo.';
    }else{
      btn.textContent='🚩 Báo cáo đáng ngờ';btn.disabled=!!summary.unavailable;
      btn.addEventListener('click',function(){openReport(domain);});
    }
    card.append(btn);card.append(note);parent.append(card);
  }
  function openReport(domain){
    $('reportDomain').textContent=domain;$('reportReason').value='';$('reportError').textContent='';
    $('submitReport').textContent=community.user?'Gửi báo cáo':'Đăng nhập Google và gửi';
    $('reportModal').hidden=false;$('reportReason').focus();
  }
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
  var BLOCKED_MSG='Không thể báo cáo tên miền này bằng tài khoản và thiết bị hiện tại.';
  async function submitReport(){
    var domain=$('reportDomain').textContent,reason=$('reportReason').value;
    if(!REASONS[reason]){$('reportError').textContent='Vui lòng chọn lý do báo cáo.';return;}
    $('submitReport').disabled=true;$('reportError').textContent='';
    try{
      var user=await ensureGoogleUser(),key=await getDeviceKey();
      if(!key)throw new Error('Không xác định được thiết bị nên chưa thể báo cáo.');
      var db=community.db,dk=base64Url(domain),TS=firebase.database.ServerValue.TIMESTAMP;
      var rRef=db.ref('reports/'+dk+'/'+user.uid),lRef=db.ref('reportLocks/'+dk+'/'+key),uRef=db.ref('userReports/'+user.uid+'/'+dk);
      if((await rRef.once('value')).exists()){$('reportError').textContent='Bạn đã báo cáo tên miền này trước đó.';return;}
      var lock=(await lRef.once('value')).val(),createdLock=false;
      if(lock&&lock.uid!==user.uid){$('reportError').textContent=BLOCKED_MSG;return;}
      if(!lock){
        try{await lRef.set({uid:user.uid,createdAt:TS});createdLock=true;}
        catch(e){$('reportError').textContent=BLOCKED_MSG;return;}   // tài khoản khác vừa giữ khoá trước
      }
      try{
        await uRef.set({deviceKey:key,createdAt:TS});
        await rRef.set({uid:user.uid,domain:domain,reason:reason,createdAt:TS});
      }catch(e){
        if(createdLock){await lRef.remove().catch(function(){});await uRef.remove().catch(function(){});}
        throw e;
      }
      closeReport();await check(lastChecked||$('url').value,true);
    }catch(e){$('reportError').textContent=e.message||'Không gửi được báo cáo.';}finally{$('submitReport').disabled=false;}
  }
  // Thu hồi: chỉ báo cáo của chính tài khoản đang đăng nhập (đường dẫn gắn với UID). Có thể làm trên bất kỳ thiết bị nào.
  async function withdrawReport(domain,btn,note){
    if(!community.user)return;
    if(!confirm('Thu hồi báo cáo của bạn về '+domain+'?'))return;
    btn.disabled=true;note.textContent='';
    try{
      var uid=community.user.uid,dk=base64Url(domain),uRef=community.db.ref('userReports/'+uid+'/'+dk);
      var key=(await uRef.once('value')).child('deviceKey').val();
      await community.db.ref('reports/'+dk+'/'+uid).remove();
      if(key)await community.db.ref('reportLocks/'+dk+'/'+key).remove();
      await uRef.remove();
      await check(lastChecked||$('url').value,true);
    }catch(e){btn.disabled=false;note.textContent='Không thu hồi được báo cáo. Vui lòng thử lại.';}
  }
  // ---- Thông tin đăng ký tên miền (chỉ hiện khi kết quả xanh) ----
  function fmtDate(s){var d=new Date(s);return isNaN(d)?null:d.toLocaleDateString('vi-VN');}
  function ageText(s){
    var days=(Date.now()-new Date(s).getTime())/864e5;
    if(!(days>=0))return '';
    if(days<60)return Math.floor(days)+' ngày';
    if(days<730)return Math.floor(days/30.4)+' tháng';
    return Math.floor(days/365.25)+' năm';
  }
  async function loadDomainInfo(domain,card){
    var body=el('div','muted','Đang tra cứu thông tin đăng ký...');card.append(body);
    try{
      var r=await fetch('/api/domain-info?domain='+encodeURIComponent(domain),{cache:'no-store',signal:AbortSignal.timeout(12000)}),j=await r.json();
      if(!r.ok)throw new Error(j.error||'Không tra cứu được.');
      var created=j.created&&fmtDate(j.created),expires=j.expires&&fmtDate(j.expires),updated=j.updated&&fmtDate(j.updated);
      var rows=[['Chủ sở hữu',j.registrant||'Không công khai (thường bị ẩn để bảo vệ quyền riêng tư)'],['Nhà đăng ký tên miền',j.registrar||'Không có dữ liệu'],
        ['Ngày đăng ký',created?created+(ageText(j.created)?' ('+ageText(j.created)+')':''):'Không có dữ liệu'],['Ngày hết hạn',expires||'Không có dữ liệu'],['Cập nhật gần nhất',updated||'Không có dữ liệu']];
      var grid=el('div','grid');
      rows.forEach(function(x){var c=el('div');c.append(el('div','label',x[0]),el('div','val',x[1]));grid.append(c);});
      var kids=[grid];
      if(j.created&&(Date.now()-new Date(j.created).getTime())<90*864e5)kids.push(el('div','warn-line','Tên miền mới đăng ký gần đây. Hãy thận trọng khi nhập thông tin cá nhân.'));
      kids.push(el('p','muted','Nguồn: dữ liệu đăng ký công khai (RDAP). Có thể thiếu hoặc bị ẩn, và không chứng nhận website an toàn.'));
      body.replaceWith.apply(body,kids);
    }catch(e){body.textContent=e.message||'Chưa lấy được thông tin đăng ký công khai.';}
  }
  async function check(value,preserveScroll) {
    var input=value!=null?value:$('url').value;lastChecked=input;var seq=++checkSeq;$('url').value=input;syncClear();setHint('');$('url').blur();
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
      if(seq!==checkSeq)return;   // đã có lần kiểm tra mới hơn
      box.replaceChildren(head,detail);
      if(finalLevel==='green'){var info=el('div','card');info.append(el('h3',null,'Thông tin đăng ký tên miền'));box.append(info);loadDomainInfo(domain,info);}
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
  $('authBtn').addEventListener('click',toggleAuth);
  $('reportModal').addEventListener('click',function(e){if(e.target===$('reportModal'))closeReport();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('reportModal').hidden)closeReport();});
  document.querySelectorAll('.chip').forEach(function (b) { b.addEventListener('click', function () { check(b.dataset.v); }); });
  syncClear();
  loadDomains();
})();
