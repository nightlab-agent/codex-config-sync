'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const BIN = process.env.REVIEW_BIN || path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const PRELOAD = path.join(__dirname, 'review-ts-race3.js');
const LIVE = 'model = "a"\n', SHARED = 'model = "b"\n';
const TRUST = '[projects."/new';
let passed = 0, failed = 0;
function test(name, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-ts-'));
  try { fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function files(d, live = LIVE, shared = SHARED) {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, live); fs.writeFileSync(sh, shared);
  return { cfg, sh };
}
function run(args, env = {}, pre = [], opts = {}) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, ...opts });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('LIMIT T1 a save inside the last instant is lost, as the README says: Codex has no lock', (d) => {
  const { cfg, sh } = files(d);
  const r = run(['apply', sh, '--config', cfg], { TS_REVIEW_CONFIG: cfg, TS_REVIEW_HITS: '3' }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!fs.readFileSync(cfg, 'utf8').includes(TRUST), 'the README can drop its limit: this save now survives');
});
test('CMP T1 a trust saved after the first verification read survives (the repo fake)', (d) => {
  const { cfg, sh } = files(d);
  const r = run(['apply', sh, '--config', cfg], { TS_REVIEW_CONFIG: cfg, TS_REVIEW_HITS: '2' }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes(TRUST));
});

test('CMP T2 fixed: "nothing written" after three retries, yet the previous .bak was overwritten', (d) => {
  const { cfg, sh } = files(d);
  fs.writeFileSync(cfg + '.bak', 'the backup from last week\n');
  const r = run(['apply', sh, '--config', cfg], { TS_REVIEW_CONFIG: cfg, TS_REVIEW_HITS: '2,5,8' }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(r.err.includes('nothing written'), r.err);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), 'the backup from last week\n', 'apply said "nothing written" but rewrote config.toml.bak');
});
test('CMP T2 a retry that is refused at the first check leaves .bak alone', (d) => {
  const { cfg, sh } = files(d);
  fs.writeFileSync(cfg + '.bak', 'the backup from last week\n');
  const r = run(['apply', sh, '--config', cfg], { TS_REVIEW_CONFIG: cfg, TS_REVIEW_HITS: '1,3,5' }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), 'the backup from last week\n');
});

test('CMP T3 fixed: the rewritten config keeps its mode under a stricter umask (comment: "exactly mode")', (d) => {
  const { cfg, sh } = files(d);
  fs.chmodSync(cfg, 0o664);
  const r = spawnSync('sh', ['-c', `umask 077 && "${process.execPath}" "${BIN}" apply "${sh}" --config "${cfg}"`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const mode = fs.statSync(cfg).mode & 0o777;
  assert.strictEqual(mode, 0o664, `config mode became ${mode.toString(8)}, not the 664 it had`);
});
test('CMP T3 the rewritten config keeps its mode under umask 022', (d) => {
  const { cfg, sh } = files(d);
  fs.chmodSync(cfg, 0o644);
  const r = spawnSync('sh', ['-c', `umask 022 && "${process.execPath}" "${BIN}" apply "${sh}" --config "${cfg}"`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.statSync(cfg).mode & 0o777, 0o644);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
