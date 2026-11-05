// Hold one apply inside its real write path until a second CLI invocation has finished.
// No config writes are simulated: the peer performs its own reads, merge, backup and rename.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const config = process.env.OVERLAP_CONFIG;
const stage = process.env.OVERLAP_STAGE;
const write = fs.writeFileSync;
const rename = fs.renameSync;
const link = fs.linkSync;
const unlink = fs.unlinkSync;
let entered = false;

function save(r, start) {
  write(process.env.OVERLAP_RESULT, JSON.stringify({
    code: r.status, signal: r.signal, error: r.error ? r.error.message : null,
    out: r.stdout, err: r.stderr,
    elapsed: Date.now() - start,
    committed: fs.readFileSync(config, 'utf8'),
    backup: fs.readFileSync(config + '.bak', 'utf8'),
  }));
}

function peer() {
  if (entered) return;
  entered = true;
  const start = Date.now();
  const args = [path.join(__dirname, '..', 'bin', 'codex-config-sync.js'), ...JSON.parse(process.env.OVERLAP_PEER_ARGS)];
  if (stage === 'stale-then-live') {
    // Let the peer replace the dead lock and pause inside its commit. Release it
    // only when the outer CLI's synchronous work has returned to the event loop.
    const ready = process.env.OVERLAP_RESULT + '.ready', release = ready + '.release';
    const c = spawn(process.execPath, ['-r', path.join(__dirname, 'review-lock-preload.js'), ...args], {
      env: { ...process.env, LOCK_CONFIG: config, LOCK_STAGE: 'hold-backup', LOCK_READY: ready, LOCK_RELEASE: release },
    });
    let out = '', err = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { err += b; });
    c.on('error', (error) => save({ status: null, signal: null, error, stdout: out, stderr: err }, start));
    c.on('close', (status, signal) => save({ status, signal, stdout: out, stderr: err }, start));
    while (!fs.existsSync(ready)) {
      if (Date.now() - start > 5000) throw new Error('peer acquisition barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    setImmediate(() => write(release, 'release'));
    return;
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, timeout: 10000 });
  save(r, start);
}

fs.writeFileSync = function (file, ...args) {
  const tmp = path.join(path.dirname(config), `.${path.basename(config)}.${process.pid}.tmp`);
  if (stage === 'before-check' && file === tmp) peer();
  return write.call(this, file, ...args);
};
fs.renameSync = function (from, to) {
  // This is inside safe(): the final unchanged() read passed, but the backup is not installed yet.
  if (stage === 'during-backup' && to === config + '.bak') peer();
  return rename.call(this, from, to);
};
fs.linkSync = function (from, to) {
  if ((stage === 'before-reap' || stage === 'stale-then-live') && from === config + '.lock') peer();
  const result = link.call(this, from, to);
  if (stage === 'during-reap' && from === config + '.lock') peer();
  if (stage === 'kill-reap' && from === config + '.lock') process.kill(process.pid, 'SIGKILL');
  return result;
};
fs.unlinkSync = function (file) {
  const result = unlink.call(this, file);
  if (stage === 'kill-after-reap' && file === config + '.lock') process.kill(process.pid, 'SIGKILL');
  return result;
};
