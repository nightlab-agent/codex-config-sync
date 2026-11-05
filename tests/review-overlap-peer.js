// Hold one apply inside its real write path until a second CLI invocation has finished.
// No config writes are simulated: the peer performs its own reads, merge, backup and rename.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const config = process.env.OVERLAP_CONFIG;
const stage = process.env.OVERLAP_STAGE;
const write = fs.writeFileSync;
const rename = fs.renameSync;
let entered = false;

function peer() {
  if (entered) return;
  entered = true;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-config-sync.js'),
    ...JSON.parse(process.env.OVERLAP_PEER_ARGS)], {
    encoding: 'utf8', env: process.env, timeout: 10000,
  });
  write(process.env.OVERLAP_RESULT, JSON.stringify({
    code: r.status, signal: r.signal, error: r.error ? r.error.message : null,
    out: r.stdout, err: r.stderr,
    committed: fs.readFileSync(config, 'utf8'),
    backup: fs.readFileSync(config + '.bak', 'utf8'),
  }));
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
