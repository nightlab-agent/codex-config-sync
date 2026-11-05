// Injects the error measured between two real processes on a 9p Windows drive (7 of 3731 opens):
// the holder's release lands so that fstat on the waiter's open lock answers ENOENT. CR_AT picks the call.
'use strict';
const fs = require('fs');
const lock = process.env.CR_CONFIG + '.lock', at = process.env.CR_AT;
const enoent = (s) => Object.assign(new Error(`ENOENT: no such file or directory, ${s}`), { code: 'ENOENT', syscall: s });
const open = fs.openSync, fstat = fs.fstatSync, unlink = fs.unlinkSync;
let armed = true, fd = -1;
fs.openSync = function (file, flags, ...a) {
  if (file === lock && flags === 'r' && armed) {
    if (at === 'open') { armed = false; unlink(lock); throw enoent('open'); }
    fd = open.call(this, file, flags, ...a);
    return fd;
  }
  return open.call(this, file, flags, ...a);
};
fs.fstatSync = function (f, ...a) {
  if (f === fd && armed) { armed = false; unlink(lock); throw enoent('fstat'); }
  return fstat.call(this, f, ...a);
};
