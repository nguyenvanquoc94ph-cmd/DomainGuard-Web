(function () {
  'use strict';
  var DG = window.DomainGuard;
  var $ = function (id) { return document.getElementById(id); };
  // AbortSignal.timeout không có trên Safari/iOS cũ: dùng AbortController để tương thích.
  function timeoutSignal(ms) {
    if (window.AbortSignal && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    if (typeof AbortController === 'undefined') return undefined;
    var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal;
  }

  // Phiên bản file, hiển thị cuối dòng "Danh sách tham chiếu" để biết trình duyệt đã nạp đúng bản mới chưa.
  var APP_VERSION = 'v6-blacklist';

  // Danh sách thương hiệu bảo vệ TÍCH HỢP SẴN (199 tên miền): luôn được dùng, kể cả khi máy chủ/Tranco/Cloudflare không trả về.
  // Giữ đồng bộ với protected_brands.json / base_domains.json. Máy chủ chỉ BỔ SUNG thêm, không thay thế danh sách này.
  var BUILTIN = [
    'vietcombank.com.vn','bidv.com.vn','vietinbank.vn','agribank.com.vn','techcombank.com','mbbank.com.vn','vpbank.com.vn','acb.com.vn','sacombank.com.vn','tpbank.com.vn','hdbank.com.vn','vib.com.vn','shb.com.vn','ocb.com.vn','msb.com.vn','seabank.com.vn','scb.com.vn','eximbank.com.vn','lpbank.com.vn','abbank.vn','vietbank.com.vn','namabank.com.vn','baovietbank.vn','pvcombank.com.vn','baca-bank.vn','vietabank.com.vn','kienlongbank.com','ncb-bank.vn','shinhan.com.vn','woori.com.vn','hsbc.com.vn','standardchartered.com.vn','uob.com.vn','cimbbank.com.vn','cake.vn','tnex.com.vn','momo.vn','zalopay.vn','vnpay.vn','viettelmoney.vn','paypal.com','wise.com','binance.com','ssi.com.vn','vndirect.com.vn','tcbs.com.vn','hsc.com.vn','miraeasset.com.vn',
    'shopee.vn','lazada.vn','tiki.vn','sendo.vn','chotot.com','thegioididong.com','dienmayxanh.com','fptshop.com.vn','cellphones.com.vn','hoanghamobile.com','bachhoaxanh.com','dienmaycholon.com','nguyenkim.com','longchau.com.vn','pharmacity.vn','nhathuocankhang.com','concung.com','hasaki.vn','coolmate.me','juno.vn','ghn.vn','giaohangtietkiem.vn','viettelpost.com.vn','vnpost.vn','jtexpress.vn','best-inc.vn','ahamove.com','grab.com','be.com.vn','xanhsm.com','vietnamairlines.com','vietjetair.com','bambooairways.com','traveloka.com','booking.com','agoda.com',
    'viettel.vn','vietteltelecom.vn','vnpt.vn','vinaphone.com.vn','mobifone.vn','fpt.com','fpt.vn','fpt-software.com','fptplay.vn','evn.com.vn','coccoc.com','bkav.com.vn','dichvucong.gov.vn','gdt.gov.vn','vneid.gov.vn','baohiemxahoi.gov.vn','vss.gov.vn','moj.gov.vn','mps.gov.vn','mic.gov.vn','chinhphu.vn','tapchibaohiemxahoi.gov.vn',
    'vnexpress.net','dantri.com.vn','tuoitre.vn','thanhnien.vn','vietnamnet.vn','24h.com.vn','kenh14.vn','laodong.vn','nhandan.vn','vtv.vn','vov.vn','cafef.vn','vietstock.vn','vneconomy.vn',
    'amazon.com','google.com','microsoft.com','apple.com','facebook.com','instagram.com','github.com','linkedin.com','netflix.com','youtube.com','outlook.com','office.com','dropbox.com','ebay.com','whatsapp.com','telegram.org','tiktok.com','x.com','twitter.com','discord.com','gmail.com','onedrive.com','icloud.com','chatgpt.com','openai.com','canva.com','zoom.us','zalo.me',
    'vingroup.net','vinfast.vn','vinfastauto.com','vinhomes.vn','vinmec.com','vinpearl.com','vinwonders.com','vinschool.edu.vn','vinuni.edu.vn','vincom.com.vn','vincom.com','gsm.vn','grabtaxi.com','fptcloud.com','aka.ai','masangroup.com','winmart.com','thaco.com.vn','thacogroup.vn','hoaphat.com.vn','hoa-phat.com','sabeco.com.vn','habeco.com.vn','petrolimex.com.vn','pvoil.com.vn','doji.vn','pnj.com.vn','vietravel.com','mytour.vn',
    'gemini.google.com','claude.ai','notion.so','teamviewer.com','anydesk.com','pinterest.com','messenger.com','threads.net','threads.com','wikipedia.org','yahoo.com','google.com.vn','topcv.vn','vieclam24h.vn','careerbuilder.vn','hocmai.vn','vietjack.com','loigiaihay.com','thuvienphapluat.vn','baomoi.com','tienphong.vn','nhathuoclongchau.com.vn'
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
              msg: 'Chưa phát hiện tên miền tương tự, ký tự giả dạng Latin, danh sách đen hoặc báo cáo từ cộng đồng.' }
  };
  var BLACKLIST_TITLE = 'ĐÃ BỊ GẮN CỜ NGUY HIỂM';
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
      $('url').focus();
      setHint('Trình duyệt không cho dán tự động. Hãy nhấn giữ vào ô nhập rồi chọn "Dán".');
    }
  }

  // ---- Cuộn tới kết quả ----
  function scrollToResult() {
    var box = $('result');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(function () { box.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); });
  }

  var SOURCE_LABELS = { cloudflareVN: 'Cloudflare Radar Việt Nam', tranco: 'Tranco' };
  var loadingDomains = false;
  var fmt = function (n) { return Number(n).toLocaleString('vi-VN'); };
  function blacklistStatusText(b) {
    if (!b || !b.feeds) return 'Danh sách đen: chưa có dữ liệu';
    var parts = Object.keys(b.feeds).map(function (k) {
      var f = b.feeds[k];
      if (!f.active) return f.name + ': tắt' + (f.needsKey ? ' (thiếu ' + f.needsKey + ')' : '');
      return f.name + ': ' + (f.count ? fmt(f.count) : 'chưa tải') + (f.error ? ' (lỗi: ' + f.error + ')' : '');
    });
    return 'Danh sách đen – ' + parts.join(', ');
  }
  async function loadDomains() {
    if (loadingDomains) return;
    loadingDomains = true;
    var btn = $('resync'); if (btn) btn.disabled = true;
    $('syncText').textContent = 'Đang tải danh sách...';
    try {
      var r = await fetch('/api/domains', { cache: 'no-store', signal: timeoutSignal(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      var server = Array.isArray(j.domains) ? j.domains : [];
      index = DG.buildIndex(BUILTIN.concat(server));
      var c = j.counts || {};
      var when = j.updatedAt && !isNaN(new Date(j.updatedAt)) ? new Date(j.updatedAt).toLocaleString('vi-VN') : 'chưa đồng bộ';
      var parts = ['Đang dùng ' + fmt(index.list.length) + ' tên miền (đã loại trùng)', 'Tích hợp sẵn trong app.js: ' + fmt(BUILTIN.length)];
      Object.keys(c).forEach(function (k) {
        var n = Number(c[k]);
        if (isFinite(n)) parts.push((SOURCE_LABELS[k] || k) + ': ' + fmt(n));
      });
      if (!server.length) parts.push('Máy chủ chưa trả thêm danh sách nào');
      parts.push('Cập nhật: ' + when);
      parts.push(blacklistStatusText(j.blacklist));
      parts.push('app.js ' + APP_VERSION);
      var text = parts.join(' · ');
      if (j.errors && j.errors.length) text += ' · Lỗi: ' + j.errors.join('; ');
      $('syncText').textContent = text;
    } catch (e) {
      index = DG.buildIndex(BUILTIN);
      $('syncText').textContent = 'Không kết nối được máy chủ (/api/domains). Đang dùng ' + BUILTIN.length + ' tên miền tích hợp sẵn; chưa kiểm tra được danh sách đen. (app.js ' + APP_VERSION + ')';
    } finally {
      loadingDomains = false;
      if (btn) btn.disabled = false;
    }
  }

  async function dnsLookup(host) {
    try {
      var r = await fetch('https://dns.google/resolve?name=' + encodeURIComponent(host) + '&type=SOA', { signal: timeoutSignal(6000) });
      if (!r.ok) return 'unknown';
      var j = await r.json();
      return j.Status === 0 ? 'found' : j.Status === 3 ? 'missing' : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // ---------- Danh sách đen (tra cứu trên máy chủ DomainGuard, không gửi cho bên thứ 3) ----------
  async function getBlacklist(input) {
    try {
      var r = await fetch('/api/blacklist?url=' + encodeURIComponent(String(input).trim()), { cache: 'no-store', signal: timeoutSignal(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      j.unavailable = !!j.empty;   // máy chủ chưa tải được nguồn nào
      return j;
    } catch (e) { return { listed: false, matches: [], sources: [], unavailable: true }; }
  }
  function blacklistReason(bl) {
    var names = bl.sources.map(function (s) { return s.name + ' (' + s.categoryLabel + ')'; }).join(', ');
    var what = bl.matches.some(function (m) { return m.type === 'host'; }) ? 'Tên miền' : 'Đường dẫn này';
    return what + ' nằm trong danh sách đen: ' + names + '.';
  }
  function addBlacklist(parent, bl) {
    var box = el('div', 'blacklist-box');
    box.append(el('div', 'blacklist-title', '⛔ Có trong danh sách đen bảo mật'));
    var ul = el('ul', 'blacklist-list');
    bl.matches.forEach(function (m) {
      m.sources.forEach(function (s) {
        var li = el('li');
        li.append(el('span', 'tag tag-blacklist', s.name));
        li.append(document.createTextNode(' ' + (s.category === 'malware' ? 'Phát tán mã độc' : 'Lừa đảo / đánh cắp thông tin') + ' · khớp ' + (m.type === 'url' ? 'đường dẫn' : 'tên miền') + ': ' + m.value));
        ul.append(li);
      });
    });
    box.append(ul);
    var adv = el('ul', 'blacklist-advice');
    ['Không mở hoặc đóng ngay trang này.', 'Không nhập mật khẩu, mã OTP, số thẻ hay thông tin cá nhân.', 'Không tải hoặc cài file từ trang này.', 'Nếu đã nhập thông tin: đổi mật khẩu và liên hệ ngân hàng ngay.']
      .forEach(function (t) { adv.append(el('li', null, t)); });
    box.append(adv);
    box.append(el('p', 'muted', 'Danh sách đen do bên thứ 3 cung cấp và có thể có độ trễ hoặc nhầm lẫn. Cập nhật: ' + (bl.updatedAt ? new Date(bl.updatedAt).toLocaleString('vi-VN') : 'không rõ') + '.'));
    parent.append(box);
  }

  // ---------- Firebase Authentication + báo cáo cộng đồng ----------
  function firebaseConfigured() {
    var c = window.DOMAIN_GUARD_FIREBASE_CONFIG || {};
    return !!(c.apiKey && c.authDomain && c.databaseURL && c.projectId && c.appId && window.firebase);
  }
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
        if (lastChecked) check(lastChecked,true);
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
        catch(e){$('reportError').textContent=BLOCKED_MSG;return;}
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
      var r=await fetch('/api/domain-info?domain='+encodeURIComponent(domain),{cache:'no-store',signal:timeoutSignal(12000) }),j=await r.json();
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
    var input=value!=null?value:$('url').value;
    if(!preserveScroll){
      if(!String(input).trim()){setHint('Hãy nhập địa chỉ website cần kiểm tra.');$('url').focus();return;}
      $('url').value=input;syncClear();setHint('');$('url').blur();
    }
    lastChecked=input;var seq=++checkSeq;
    var box=$('result');box.replaceChildren(el('div','card muted','Đang kiểm tra...'));$('scan').disabled=true;if(!preserveScroll)scrollToResult();
    try{
      var r=DG.analyze(input,index),lookup=null,latinName=null;
      var needLookup=r.nonAscii&&r.latin!==r.host&&/^[a-z0-9.-]+$/.test(r.latin)&&!r.matches.some(function(m){return m.type==='visual';});
      var domain=reportDomain(r);
      // Tra DNS, danh sách đen và báo cáo cộng đồng song song.
      var results=await Promise.all([
        needLookup?(latinName=DG.registrable(r.latin),dnsLookup(latinName)):Promise.resolve(null),
        getBlacklist(input),
        getReports(domain)
      ]);
      lookup=results[0];var bl=results[1],reports=results[2];
      var rating=DG.rate(r,lookup,latinName);
      if(bl.listed){rating.level='red';rating.reasons.unshift(blacklistReason(bl));}
      var finalLevel=rating.level==='red'?'red':reports.count>0?'yellow':rating.level,L=LEVELS[finalLevel];
      var head=el('div','card '+L.cls);head.append(el('h2',null,L.icon+' '+(bl.listed?BLACKLIST_TITLE:L.title)));
      var msg=L.msg;
      if(bl.listed){
        msg='Địa chỉ này đã được các nguồn bảo mật độc lập ghi nhận là '+(bl.sources.some(function(s){return s.category==='malware';})?'phát tán mã độc':'lừa đảo')+'. Không nên truy cập, nhập thông tin hay tải file từ trang này.';
      }else if(finalLevel==='yellow'){
        if(reports.count>0&&rating.level==='green')msg='Không phát hiện dấu hiệu giả dạng tên miền, nhưng đã có '+reports.count.toLocaleString('vi-VN')+' báo cáo từ cộng đồng. Hãy thận trọng trước khi truy cập.';
        else if(reports.count>0)msg='Đã phát hiện dấu hiệu bất thường và có '+reports.count.toLocaleString('vi-VN')+' báo cáo từ cộng đồng. Hãy thận trọng trước khi truy cập.';
        else msg='Đã phát hiện dấu hiệu bất thường. Hãy thận trọng trước khi truy cập.';
      }else if(finalLevel==='green'){
        var miss=[];if(bl.unavailable)miss.push('danh sách đen');if(reports.unavailable)miss.push('báo cáo từ cộng đồng');
        if(miss.length)msg='Chưa phát hiện tên miền tương tự hoặc ký tự giả dạng Latin. Lưu ý: chưa kiểm tra được '+miss.join(' và ')+'.';
      }
      head.append(el('div','msg',msg));
      if(rating.reasons.length){var ul=el('ul','reasons');rating.reasons.forEach(function(t){ul.append(el('li',null,t));});head.append(ul);}
      if(bl.listed)addBlacklist(head,bl);
      addCommunity(head,reports,domain);
      var detail=el('div','card');detail.append(el('h3',null,'Chi tiết phân tích'));var grid=el('div','grid');
      var blText=bl.unavailable?'Chưa kiểm tra được':bl.listed?'Có ('+bl.sources.map(function(s){return s.name;}).join(', ')+')':'Không có trong danh sách đen đang theo dõi';
      [['Tên miền đầu vào',r.host],['Dạng ASCII (Punycode) của trình duyệt',r.ascii],['Dạng Latin chuyển đổi',r.latin],['Ký tự ngoài Latin',r.nonAscii?'Có':'Không'],['Tra cứu DNS tên miền Latin'+(latinName?' ('+latinName+')':''),lookup===null?'Không cần tra cứu':lookup==='found'?'Có tồn tại':lookup==='missing'?'Không tồn tại':'Không xác minh được'],['Danh sách đen',blText]].forEach(function(x){var c=el('div');c.append(el('div','label',x[0]),el('div','val',x[1]));grid.append(c);});detail.append(grid);
      if(r.matches.length){
        detail.append(el('div','label','Tên miền tham chiếu tương tự'));
        var seen={};
        r.matches.forEach(function(m){
          var k=m.domain+'|'+m.type;if(seen[k])return;seen[k]=1;
          detail.append(el('span','tag',m.domain+' · '+(TYPE_LABEL[m.type]||m.type||'tương tự')));
        });
      }
      if(r.canonical)detail.append(el('p','muted','Tên miền thuộc '+r.canonical+' trong danh sách tham chiếu (danh sách dựa trên độ phổ biến, không chứng nhận an toàn).'));
      if(seq!==checkSeq)return;
      box.replaceChildren(head,detail);
      if(finalLevel==='green'){var info=el('div','card');info.append(el('h3',null,'Thông tin đăng ký tên miền'));box.append(info);loadDomainInfo(domain,info);}
    }catch(e){if(seq===checkSeq)box.replaceChildren(el('div','card risk-yellow',e.message||'Không kiểm tra được địa chỉ này.'));}
    finally{if(seq===checkSeq){$('scan').disabled=false;if(!preserveScroll)scrollToResult();}}
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
