// Records the stack of any raw ENOENT that reaches the user, and the lock's state at that moment.
'use strict';
const fs = require('fs');
const raw = fs.writeFileSync, log = process.env.CR_TRACE;
for (const name of ['fstatSync', 'readFileSync', 'closeSync', 'linkSync', 'lstatSync', 'unlinkSync', 'openSync']) {
  const orig = fs[name];
  fs[name] = function (...a) {
    try { return orig.apply(this, a); }
    catch (e) {
      if (e.code === 'ENOENT' && (name === 'fstatSync' || (e.syscall === 'fstat'))) raw(log, `${process.pid} ${name} ${JSON.stringify(a[0])} ${e.syscall}\n${new Error().stack.split('\n').slice(2, 6).join('\n')}\n`, { flag: 'a' });
      throw e;
    }
  };
}
