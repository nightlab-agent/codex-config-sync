// Gate review (s465): each suspected fault beside its nearest passing comparison.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
let passed = 0, failed = 0;

function test(name, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-gate-'));
  try { fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function run(args, pre = [], env = {}) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function withUmask(mask, fn) {
  const old = process.umask(mask);
  try { return fn(); } finally { process.umask(old); }
}
const octal = (f) => (fs.statSync(f).mode & 0o777).toString(8);

// --- G1: "the mode kept" is masked by the umask of the run (open(2): mode & ~umask) ---
function applyWithMode(d, mode) {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, 'model = "a"\n'); fs.chmodSync(cfg, mode);
  fs.writeFileSync(sh, 'model = "b"\n');
  const r = withUmask(0o022, () => run(['apply', sh, '--config', cfg]));
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(octal(cfg), mode.toString(8), `config mode after apply: ${octal(cfg)}, was ${mode.toString(8)}`);
  assert.strictEqual(octal(cfg + '.bak'), mode.toString(8), `backup mode: ${octal(cfg + '.bak')}, config was ${mode.toString(8)}`);
}
test('BUG G1 apply keeps a group-writable config (0664) under umask 022', (d) => applyWithMode(d, 0o664));
test('CMP G1 apply keeps a 0644 config under umask 022', (d) => applyWithMode(d, 0o644));

function extractWithMode(d, mode) {
  const cfg = path.join(d, 'config.toml'), out = path.join(d, 'out.toml');
  fs.writeFileSync(cfg, 'model = "a"\n');
  fs.writeFileSync(out, 'model = "old"\n'); fs.chmodSync(out, mode);
  const r = withUmask(0o022, () => run(['extract', '--config', cfg, '-o', out]));
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(octal(out), mode.toString(8), `output mode after extract: ${octal(out)}, was ${mode.toString(8)}`);
}
test('BUG G1b extract -o keeps a group-writable output (0664) under umask 022', (d) => extractWithMode(d, 0o664));
test('CMP G1b extract -o keeps a 0644 output under umask 022', (d) => extractWithMode(d, 0o644));

// --- G2: a link whose text passes through a component the system cannot enter, then `..` ---
function extractThroughBroken(d, makeComponent) {
  const target = path.join(d, 'target.toml');
  fs.writeFileSync(target, 'unrelated notes\n');
  makeComponent(path.join(d, 'step'));
  const out = path.join(d, 'out.toml');
  fs.symlinkSync('step/../target.toml', out);
  let osErr = null;
  try { fs.realpathSync.native(out); } catch (e) { osErr = e.code; }
  assert.ok(osErr, 'the OS must refuse this path');
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, 'model = "new"\n');
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'unrelated notes\n',
    `extract wrote the unrelated file (OS says ${osErr}); exit ${r.code}, stderr: ${r.err.trim()}`);
  assert.notStrictEqual(r.code, 0, 'extract must refuse where the OS refuses');
}
test('BUG G2 a link through a dangling link then .. does not reach an unrelated file', (d) =>
  extractThroughBroken(d, (p) => fs.symlinkSync(path.join(d, 'nowhere'), p)));
test('BUG G2b a link through a plain file then .. does not reach an unrelated file', (d) =>
  extractThroughBroken(d, (p) => fs.writeFileSync(p, 'a file, not a folder\n')));
test('CMP G2 a link through a real folder then .. reaches the OS target', (d) => {
  fs.mkdirSync(path.join(d, 'step'));
  const target = path.join(d, 'target.toml');
  fs.writeFileSync(target, 'old\n');
  const out = path.join(d, 'out.toml');
  fs.symlinkSync('step/../target.toml', out);
  assert.strictEqual(fs.realpathSync.native(out), target);
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, 'model = "new"\n');
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'model = "new"\n');
  assert.strictEqual(fs.readFileSync(target + '.bak', 'utf8'), 'old\n'); // beside the target, not the link
  assert.ok(!fs.existsSync(out + '.bak'));
});
test('CMP G2c a dangling link as the last step is written through (documented)', (d) => {
  const out = path.join(d, 'out.toml');
  fs.symlinkSync(path.join(d, 'made.toml'), out);
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, 'model = "new"\n');
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(path.join(d, 'made.toml'), 'utf8'), 'model = "new"\n');
});

// --- G3: runs twice / dies halfway ---
test('CMP G3 apply twice: the second run writes nothing', (d) => {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, '﻿model = "a"\r\n\r\n[projects."/x"]\r\ntrust_level = "trusted"\r\n');
  fs.writeFileSync(sh, 'model = "b"\n');
  assert.strictEqual(run(['apply', sh, '--config', cfg]).code, 0);
  const first = fs.readFileSync(cfg, 'utf8');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.startsWith('already in sync'), r.out);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), first);
});
test('CMP G3b a temp file left by a killed run does not block the next', (d) => {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, 'model = "a"\n'); fs.writeFileSync(sh, 'model = "b"\n');
  fs.writeFileSync(path.join(d, '.config.toml.12345.tmp'), 'half\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), 'model = "b"\n');
});
test('CMP G3c apply killed after backup preserves settings; retry matches a successful sync', (d) => {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  const control = path.join(d, 'control.toml');
  const live = 'model = "a"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
  const shared = 'model = "b"\n';
  fs.writeFileSync(cfg, live); fs.writeFileSync(control, live); fs.writeFileSync(sh, shared);
  fs.chmodSync(cfg, 0o600); fs.chmodSync(control, 0o600);
  fs.writeFileSync(cfg + '.bak', 'model = "previous"\n');

  const normal = run(['apply', sh, '--config', control]);
  assert.strictEqual(normal.code, 0, normal.err);
  const expected = shared + '\n[projects."/work"]\ntrust_level = "trusted"\n';
  assert.strictEqual(fs.readFileSync(control, 'utf8'), expected);
  assert.strictEqual(fs.readFileSync(control + '.bak', 'utf8'), live);

  // The first rename installs the backup; stop just before the second replaces the live file.
  const killed = spawnSync(process.execPath, ['-r', path.join(__dirname, 'review-link-kill.js'),
    BIN, 'apply', sh, '--config', cfg], {
    encoding: 'utf8', env: { ...process.env, LINK_REVIEW_KILL_RENAME: '2' },
  });
  assert.strictEqual(killed.signal, 'SIGKILL', `exit ${killed.status}: ${killed.stderr}`);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), live);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), live);
  assert.strictEqual(octal(cfg), '600');
  assert.strictEqual(octal(cfg + '.bak'), '600');
  assert.ok(fs.readdirSync(d).some((f) => /^\.config\.toml\.\d+\.tmp$/.test(f)));

  const retry = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(retry.code, 0, retry.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), expected);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), live);
  assert.strictEqual(octal(cfg), '600');
  assert.strictEqual(octal(cfg + '.bak'), '600');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
