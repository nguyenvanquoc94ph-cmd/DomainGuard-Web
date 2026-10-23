const DG=require('../public/detector.js'); const {merge}=require('../server.js');
const base=require('../config/base_domains.json').domains;
const idx=DG.buildIndex(base.concat(['vnexpress.net','dantri.com.vn']));
const cases=[['аmazon.com','warning'],['amaz0n.com','warning'],['arnazon.com','warning'],['vietc0mbank.com.vn','warning'],
['www.vietc0mbank.com.vn','warning'],['https://login.vietc0mbank.com.vn/x','warning'],['www.shope.vn','warning'],['vnexpres.net','warning'],
['amazon.com','known'],['www.vietcombank.com.vn','known'],['example-unrelated.org','clear'],['xn--mazon-3ve.com','warning']];
let fail=0; for(const [i,exp] of cases){const r=DG.analyze(i,idx);const ok=r.status===exp;if(!ok)fail++;console.log(ok?'PASS':'FAIL',i,'->',r.status,r.matches.map(m=>m.domain).join(','),r.latin);}
const vn=Array.from({length:2100},(_,i)=>'vn'+i+'.vn').concat(['googleapis.com']);
const tr=['googleapis.com','vn1.vn'].concat(Array.from({length:3500},(_,i)=>'t'+i+'.com'));
const m=merge(vn,tr); console.log('merge',m.counts,m.domains.length, m.domains.includes('googleapis.com'));
process.exit(fail?1:0);
