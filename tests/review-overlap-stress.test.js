// Parallel applies without barriers preserve every successful compatible update.
'use strict';
const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  BIN, MCP_OLD, MCP_NEW, PROFILE_OLD, PROFILE_NEW, test, files, contains, remedy, noLock, deadPid,
  putLock, finish,
} = require('./review-overlap-helpers');

function parallel(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: process.env, timeout: 15000 });
    let out = '', err = '', error;
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { error = e; });
    child.on('close', (code, signal) => resolve({ code, signal, out, err, error }));
  });
}
test('CMP six parallel applies without barriers preserve every successful compatible update', async (d) => {
  const rounds = Number(process.env.OVERLAP_ROUNDS || 12);
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0, 'OVERLAP_ROUNDS must be a positive integer');
  const dead = deadPid();
  let completed = 0, refused = 0;
  for (let n = 0; n < rounds; n++) {
    const f = files(d);
    if (n % 2) putLock(f.cfg, dead);
    const operations = ['mcp', 'profile', 'mcp', 'profile', 'mcp', 'profile'];
    const results = await Promise.all(operations.map((op) => parallel(f[op])));
    for (const r of results) {
      assert.ifError(r.error);
      assert.strictEqual(r.signal, null, r.err);
      if (r.code === 0) completed++;
      else {
        assert.strictEqual(r.code, 2, r.err);
        assert.match(r.err, /lock busy after waiting 500 ms/, 'only a bounded busy-lock refusal is expected');
        remedy(r, f.cfg);
        refused++;
      }
    }
    assert.ok(results.some((r) => r.code === 0), 'at least one apply must finish');
    const succeeded = (op) => results.some((r, i) => operations[i] === op && r.code === 0);
    contains(fs.readFileSync(f.cfg, 'utf8'), succeeded('mcp') ? MCP_NEW : MCP_OLD,
      succeeded('profile') ? PROFILE_NEW : PROFILE_OLD);
    noLock(f.cfg);
  }
  console.log(`     ${rounds * 6} runs: ${completed} succeeded, ${refused} busy refusals, 0 lost updates`);
});



finish();
