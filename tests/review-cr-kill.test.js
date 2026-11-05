'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {spawnSync}=require('child_process');
const BIN=path.join(__dirname,'..','bin','codex-config-sync.js'),PRE=path.join(__dirname,'review-cr-kill-preload.js');
const LIVE='model = "a"\nkeepme = 1\n\n[mcp_servers.docs]\ncommand = "old"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
const SHARED='model = "b"\n\n[mcp_servers.docs]\ncommand = "new"\n';
const WANT='model = "b"\n\n[mcp_servers.docs]\ncommand = "new"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
const PREV='model = "previous"\n';
function deadPid(){return spawnSync(process.execPath,['-e','']).pid;}
const base=process.env.CR_TMP||os.tmpdir();
let rows=[],fail=0;
for(const start of (process.env.CR_START||'clean,stale,stale+claim').split(','))for(const when of (process.env.CR_WHEN||'before,after').split(','))for(let at=1;at<30;at++){
  const d=fs.mkdtempSync(path.join(base,'k-'));const cfg=d+'/config.toml',sh=d+'/shared.toml';
  fs.writeFileSync(cfg,LIVE);fs.writeFileSync(cfg+'.bak',PREV);fs.writeFileSync(sh,SHARED);
  if(start!=='clean')fs.writeFileSync(cfg+'.lock',JSON.stringify({pid:deadPid(),host:os.hostname()})+'\n');
  if(start==='stale+claim')fs.linkSync(cfg+'.lock',`${cfg}.lock.reap-${Buffer.from(os.hostname()).toString('hex')}-${deadPid()}-00000000-0000-4000-8000-000000000000`);
  const log=d+'/log';
  const r=spawnSync(process.execPath,['-r',PRE,BIN,'apply',sh,'--config',cfg],{encoding:'utf8',env:{...process.env,KILL_AT:at,KILL_WHEN:when,KILL_LOG:log}});
  if(r.signal===null){fs.rmSync(d,{recursive:true,force:true});if(at<22)continue;break;}
  const step=fs.readFileSync(log,'utf8').trim().split('\n').find(l=>l.startsWith(at+' '));
  const live=fs.readFileSync(cfg,'utf8');
  const problems=[];
  if(live!==LIVE&&live!==WANT)problems.push('live torn');
  const bak=fs.readFileSync(cfg+'.bak','utf8');
  if(bak!==PREV&&bak!==LIVE)problems.push('bak torn');
  const retry=spawnSync(process.execPath,[BIN,'apply',sh,'--config',cfg],{encoding:'utf8'});
  let verdict='heals';
  if(retry.status!==0){verdict='REFUSED: '+retry.stderr.slice(0,110);}
  else{
    if(fs.readFileSync(cfg,'utf8')!==WANT)problems.push('retry result differs');
    if(fs.readFileSync(cfg+'.bak','utf8')!==LIVE)problems.push('bak after retry differs: '+JSON.stringify(fs.readFileSync(cfg+'.bak','utf8')));
    const rest=fs.readdirSync(d).filter(f=>f.includes('.lock'));
    if(rest.length)problems.push('residue '+rest);
  }
  rows.push(`${start} ${when} ${step} -> ${verdict} ${problems.join('; ')}`);
  if(problems.length||retry.status!==0)fail++;
  fs.rmSync(d,{recursive:true,force:true});
}
console.log(rows.join('\n'));console.log('steps',rows.length,'not healed',fail);
