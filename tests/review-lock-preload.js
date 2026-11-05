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
    const e = new Error(`hard links unsupported`); e.code = 'ENOTSUP'; throw e;
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

// Faults at the actual lock boundary, with exit assertions so a fake cannot go unused.
const write = fs.writeFileSync, unlink = fs.unlinkSync, lstat = fs.lstatSync, readlink = fs.readlinkSync;
let ownedFd, injected = false, probes = 0;
const hookedOpen = fs.openSync;
fs.openSync = function (file, flags, ...args) {
  if (file === config + '.lock' && flags === 'r' && stage === 'open-gone' && !injected) {
    injected = true;
    unlink(file);
  }
  const fd = hookedOpen.call(this, file, flags, ...args);
  if (file === config + '.lock' && flags === 'wx') ownedFd = fd;
  return fd;
};
fs.writeFileSync = function (file, ...args) {
  if (file === ownedFd && stage === 'record-error') {
    injected = true;
    write(file, '{"pid":');
    throw Object.assign(new Error('injected record write failure'), {code:'EIO'});
  }
  return write.call(this, file, ...args);
};
const hookedRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (file === config && stage === 'unlock-gone' && !injected) {
    injected = true;
    unlink(config + '.lock');
  }
  if (file === config && stage === 'no-namespace') {
    assert.strictEqual(JSON.parse(read(config + '.lock', 'utf8')).namespace, null);
  }
  return hookedRead.call(this, file, ...args);
};
fs.unlinkSync = function (file, ...args) {
  if (file === config + '.lock' && stage === 'unlink-gone') {
    injected = true;
    unlink(file); // The real second unlink below supplies ENOENT.
  }
  if (file === config + '.lock' && stage === 'unlock-error') {
    injected = true;
    throw Object.assign(new Error('injected unlock failure'), {code:'EACCES'});
  }
  return unlink.call(this, file, ...args);
};
fs.readlinkSync = function (file, ...args) {
  if (file === '/proc/self/ns/pid' && stage === 'namespace-foreign') return 'pid:[foreign]';
  if (file === '/proc/self/ns/pid' && stage === 'no-namespace') {
    injected = true;
    throw Object.assign(new Error('namespace unavailable'), {code:'ENOENT'});
  }
  return readlink.call(this, file, ...args);
};
if (stage === 'kill-eperm' || stage === 'foreign-namespace' || stage === 'last-try') {
  const kill = process.kill;
  process.kill = function (pid, signal) {
    if (stage === 'foreign-namespace') {
      injected = true;
      throw Object.assign(new Error('foreign holder is invisible here'), {code:'ESRCH'});
    }
    if (signal === 0) {
      injected = true;
      if (stage === 'kill-eperm') throw Object.assign(new Error('injected kill EPERM'), {code:'EPERM'});
      // At 50 ms intervals the eleventh probe is the last scheduled recovery check.
      if (++probes === 11) throw Object.assign(new Error('injected holder death'), {code:'ESRCH'});
      return;
    }
    return kill.call(this, pid, signal);
  };
}
if (stage === 'large-inode') {
  const hookedFstat = fs.fstatSync;
  fs.fstatSync = function (fd, ...args) {
    const stat = hookedFstat.call(this, fd, ...args);
    if (fd === recoveryFd) stat.ino = typeof stat.ino === 'bigint' ? 9007199254740992n : Number(9007199254740992n);
    return stat;
  };
  fs.lstatSync = function (file, ...args) {
    const stat = lstat.call(this, file, ...args);
    if (stat && (file === config + '.lock' || file.startsWith(config + '.lock.reap-'))) {
      injected = true;
      // Adjacent real inodes collapse to the same double, but differ as bigint.
      stat.ino = typeof stat.ino === 'bigint' ? 9007199254740993n : Number(9007199254740993n);
    }
    return stat;
  };
}
if (['unlock-gone','unlock-error','unlink-gone','record-error','no-namespace','kill-eperm','last-try','open-gone','large-inode'].includes(stage)) {
  process.on('exit', () => assert.ok(injected, `${stage} injection must be reached`));
}

if (stage === 'foreign-namespace') process.on('exit', () => assert.ok(!injected, 'must not probe a foreign PID namespace'));
