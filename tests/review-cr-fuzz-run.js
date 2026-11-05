'use strict';
const fs=require('fs'),path=require('path');
const {split,merge}=require('../bin/toml-lines.js');
const cases=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const res=[];
const doc=(t)=>({...split(t.replace(/^\ufeff/,'')),text:t});
for(const c of cases){try{const s=doc(c.shared),l=doc(c.live);const m=merge(s,l,['projects']);
 const text=m.lines.join(l.eol)+l.eol;split(text);
 const again=merge(doc(text),doc(text),['projects']);
 res.push({text,idem:again.lines.join(l.eol)+l.eol===text});}catch(e){res.push({err:e.message});}}
fs.writeFileSync(process.argv[3],JSON.stringify(res));
console.log('not idempotent',res.filter(r=>r.idem===false).length);
