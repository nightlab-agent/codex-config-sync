// SIGKILL just before, or just after, the Nth mutating fs call of the process.
'use strict';
const fs = require('fs');
const at = Number(process.env.KILL_AT), when = process.env.KILL_WHEN || 'before';
const log = process.env.KILL_LOG;
const names = ['openSync','writeFileSync','closeSync','linkSync','unlinkSync','renameSync','chmodSync','rmSync','mkdirSync'];
let n = 0;
const rawWrite = fs.writeFileSync; const append = (f, t) => rawWrite(f, t, { flag: 'a' });
for (const name of names) {
  const orig = fs[name];
  fs[name] = function (...a) {
    const mutating = name !== 'openSync' || a[1] === 'wx';
    if (!mutating || name === 'closeSync') return orig.apply(this, a);
    const me = ++n;
    const tag = `${me} ${name} ${typeof a[0] === 'string' ? require('path').basename(a[0]) : 'fd'}\n`;
    if (log) append(log, tag);
    if (me === at && when === 'before') process.kill(process.pid, 'SIGKILL');
    const r = orig.apply(this, a);
    if (me === at && when === 'after') process.kill(process.pid, 'SIGKILL');
    return r;
  };
}
