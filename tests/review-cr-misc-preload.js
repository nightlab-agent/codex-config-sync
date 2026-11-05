// Stages for tests/review-cr.test.js. Each models one fact and says so.
'use strict';
const fs = require('fs');
const stage = process.env.CR_STAGE, config = process.env.CR_CONFIG;
if (stage === 'other-pid-space') {
  // Model: this process shares the hostname but not the PID space of the lock holder, so
  // kill(holder, 0) answers ESRCH although the holder is alive (a Windows and a WSL process
  // sharing one CODEX_HOME report one hostname and separate PIDs).
  const kill = process.kill, holder = Number(process.env.CR_HOLDER);
  process.kill = function (pid, sig) {
    if (pid === holder) { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; }
    return kill.call(this, pid, sig);
  };
}
if (stage === 'dies-on-last-try') {
  // A live holder dies just before the last try: the 11th exclusive open sees its lock.
  const open = fs.openSync; let n = 0;
  fs.openSync = function (file, flags, ...a) {
    if (file === config + '.lock' && flags === 'wx' && ++n === 11) {
      fs.writeFileSync(file, JSON.stringify({ pid: Number(process.env.CR_DEAD), host: require('os').hostname() }));
    }
    return open.call(this, file, flags, ...a);
  };
}
