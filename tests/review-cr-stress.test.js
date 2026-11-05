'use strict';
// Real parallel applies, no preload. Each writer owns one table; an exit 0 must leave its value.
const fs=require('fs'),os=require('os'),path=require('path');const {spawn,spawnSync}=require('child_process');
const BIN=path.join(__dirname,'..','bin','codex-config-sync.js');const base=process.env.CR_TMP||os.tmpdir();
const N=Number(process.env.CR_N||6),ROUNDS=Number(process.env.CR_ROUNDS||15),CHAOS=process.env.CR_CHAOS==='1';
const dead=()=>spawnSync(process.execPath,['-e','']).pid;
(async()=>{let lost=0,ok=0,ref=0,killed=0,torn=0,wedged=0,residue=0,other={};
for(let round=0;round<ROUNDS;round++){
  const d=fs.mkdtempSync(path.join(base,'st-'));const cfg=d+'/config.toml';
  const tabs=[...Array(N).keys()].map(i=>`[t${i}]\nv = "old"`);
  fs.writeFileSync(cfg,'model = "a"\n\n'+tabs.join('\n\n')+'\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  if(round%2)fs.writeFileSync(cfg+'.lock',JSON.stringify({pid:dead(),host:os.hostname()})+'\n');
  const runs=[];
  for(let i=0;i<N;i++){
    fs.writeFileSync(`${d}/s${i}.toml`,`model = "a"\n\n[t${i}]\nv = "new"\n`);
    const keep=['--keep','projects'];for(let j=0;j<N;j++)if(j!==i)keep.push('--keep',`t${j}`);
    const c=spawn(process.execPath,[BIN,'apply',`${d}/s${i}.toml`,'--config',cfg,...keep]);
    let err='';c.stderr.on('data',b=>err+=b);
    runs.push(new Promise(res=>c.on('close',(code,sig)=>res({i,code,sig,err}))));
    if(CHAOS&&Math.random()<.5)setTimeout(()=>{try{c.kill('SIGKILL')}catch{}},20+Math.random()*90);
  }
  const rs=await Promise.all(runs);const text=fs.readFileSync(cfg,'utf8');
  if(!/\[projects\."\/w"\]/.test(text)||!/model = "a"/.test(text))torn++;
  for(const r of rs){
    if(r.code===0){ok++;if(!new RegExp(`\\[t${r.i}\\]\\nv = "new"`).test(text)){lost++;console.log('LOST',round,r.i,text.replace(/\n/g,' '));}}
    else if(r.sig)killed++;
    else if(r.code===2){ref++;const k=r.err.replace(/\/\S+/g,'P').replace(/\d+/g,'#').slice(0,70);other[k]=(other[k]||0)+1;}
    else{const k='code '+r.code+' '+r.err.slice(0,80);other[k]=(other[k]||0)+1;}
  }
  const left=fs.readdirSync(d).filter(f=>f.includes('.lock'));
  if(left.length){residue++;const rc=spawnSync(process.execPath,[BIN,'check',`${d}/s0.toml`,'--config',cfg]);
    const rr=spawnSync(process.execPath,[BIN,'apply',`${d}/s0.toml`,'--config',cfg,...['--keep','projects'],...[...Array(N).keys()].filter(j=>j).flatMap(j=>['--keep',`t${j}`])],{encoding:'utf8'});
    if(rr.status!==0)wedged++;else if(fs.readdirSync(d).some(f=>f.includes('.lock')))wedged++;}
  fs.rmSync(d,{recursive:true,force:true});
}
console.log(JSON.stringify({rounds:ROUNDS,N,ok,refused:ref,killed,lost,torn,residue,wedged,other},null,0));process.exitCode=lost||torn?1:0;})();
