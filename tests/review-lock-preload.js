// Assert the lock boundary through real CLI reads, or model a refused filesystem primitive.
'use strict';
const assert = require('assert');
const fs = require('fs');

const config = process.env.LOCK_CONFIG;
const stage = process.env.LOCK_STAGE;
const open = fs.openSync, read = fs.readFileSync, link = fs.linkSync, rename = fs.renameSync;
const fstat = fs.fstatSync;
let recoveryFd, statFailed = false;
fs.openSync = function (file, flags, ...args) {
  if (file === config + '.lock' && flags === 'wx') {
    assert.notStrictEqual(stage, 'no-lock', 'this command must not acquire a lock');
    if (stage === 'no-exclusive') {
      const e = new Error(`${file}: exclusive create unsupported`); e.code = 'ENOTSUP'; throw e;
    }
  }
  const fd = open.call(this, file, flags, ...args);
  if (file === config + '.lock' && flags === 'r') recoveryFd = fd;
  return fd;
};
fs.fstatSync = function (fd, ...args) {
  if (fd === recoveryFd && !statFailed && (stage === 'stat-gone' || stage === 'stat-error')) {
    statFailed = true;
    // drvfs can report ENOENT on this descriptor after the holder unlinks its lock.
    if (stage === 'stat-gone') fs.unlinkSync(config + '.lock');
    const e = new Error('injected recovery fstat failure');
    e.code = stage === 'stat-gone' ? 'ENOENT' : 'EIO';
    throw e;
  }
  return fstat.call(this, fd, ...args);
};
if (stage === 'stat-gone' || stage === 'stat-error') {
  process.on('exit', () => assert.ok(statFailed, 'the recovery fstat must be reached'));
}
fs.readFileSync = function (file, ...args) {
  if (file === config && stage === 'locked-read') {
    assert.ok(fs.existsSync(config + '.lock'), 'apply must lock before any live read');
    const owner = JSON.parse(read(config + '.lock', 'utf8'));
    assert.strictEqual(owner.pid, process.pid, 'apply must own the lock before any live read');
  }
  return read.call(this, file, ...args);
};
fs.linkSync = function (from, ...args) {
  if (from === config + '.lock' && stage === 'no-links') {
    const e = new Error(`${from}: hard links unsupported`); e.code = 'ENOTSUP'; throw e;
  }
  return link.call(this, from, ...args);
};
fs.renameSync = function (from, to) {
  if (stage === 'hold-backup' && to === config + '.bak') {
    fs.writeFileSync(process.env.LOCK_READY, 'ready');
    const end = Date.now() + 5000;
    while (!fs.existsSync(process.env.LOCK_RELEASE)) {
      if (Date.now() > end) throw new Error('peer release barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return rename.call(this, from, to);
};
