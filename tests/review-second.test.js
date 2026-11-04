// Second review: each confirmed fault beside its nearest passing comparison.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const PRELOAD = path.join(__dirname, 'review-second-race.js');
const LIVE = 'model = "a"\n';
const SHARED = 'model = "b"\n';
const TRUST = '\n[projects."/new"]\ntrust_level = "trusted"\n';
let passed = 0, failed = 0;

function test(name, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-second-'));
  try { fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function files(d, live = LIVE, shared = SHARED) {
  const cfg = path.join(d, 'config.toml'), sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, live); fs.writeFileSync(sh, shared);
  return { cfg, sh };
}
function run(args, env = {}, pre = []) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('BUG R1 trust saved after the verification read survives apply', (d) => {
  const { cfg, sh } = files(d);
  const r = run(['apply', sh, '--config', cfg], { SECOND_REVIEW_CONFIG: cfg }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes(TRUST.trim()), 'apply lost the newly saved trust table');
});
test('CMP R1 trust saved before apply survives', (d) => {
  const { cfg, sh } = files(d, LIVE + TRUST);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes(TRUST.trim()));
});

test('BUG R2 a backup symlink cannot overwrite an unrelated file', (d) => {
  const { cfg, sh } = files(d);
  const unrelated = path.join(d, 'notes.txt');
  fs.writeFileSync(unrelated, 'keep these notes\n');
  fs.symlinkSync(unrelated, cfg + '.bak');
  run(['apply', sh, '--config', cfg]);
  assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'keep these notes\n', 'apply overwrote the backup symlink target');
});
test('CMP R2 a plain backup is updated without touching another file', (d) => {
  const { cfg, sh } = files(d);
  const unrelated = path.join(d, 'notes.txt');
  fs.writeFileSync(unrelated, 'keep these notes\n'); fs.writeFileSync(cfg + '.bak', 'old backup\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'keep these notes\n');
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), LIVE);
});

test('BUG R3 a TOML eight-digit Unicode escape still names projects', (d) => {
  const { cfg } = files(d, '["\\U00000070rojects"."/x"]\ntrust_level = "trusted"\n');
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '\n', 'machine-local trust leaked into the shared extract');
});
test('CMP R3 a four-digit Unicode escape names projects', (d) => {
  const { cfg } = files(d, '["\\u0070rojects"."/x"]\ntrust_level = "trusted"\n');
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '\n');
});

test('BUG R4 separate array elements may each define the same child table', (d) => {
  const shared = '[[servers]]\n[servers.env]\nA = "a"\n\n[[servers]]\n[servers.env]\nA = "b"\n';
  const { cfg, sh } = files(d, '', shared);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8').match(/\[servers.env\]/g).length, 2);
});
test('CMP R4 separate array elements with inline children are accepted', (d) => {
  const shared = '[[servers]]\nenv = { A = "a" }\n\n[[servers]]\nenv = { A = "b" }\n';
  const { cfg, sh } = files(d, '', shared);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), shared);
});

test('BUG R5 check reports a filesystem error with exit 2', (d) => {
  const { sh } = files(d);
  const r = run(['check', sh, '--config', d]);
  assert.strictEqual(r.code, 2, `directory read returned exit ${r.code}, reserved for drift`);
});
test('CMP R5 check reports a missing shared file with exit 2', (d) => {
  const { cfg } = files(d);
  const r = run(['check', path.join(d, 'missing.toml'), '--config', cfg]);
  assert.strictEqual(r.code, 2, r.err);
});

test('BUG R6 extract through a dangling symlink creates its target', (d) => {
  const { cfg } = files(d);
  const target = path.join(d, 'target.toml'), link = path.join(d, 'link.toml');
  fs.symlinkSync(target, link);
  const r = run(['extract', '--config', cfg, '-o', link]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'extract replaced the dangling symlink');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), LIVE);
});
test('CMP R6 extract through an existing symlink updates its target', (d) => {
  const { cfg } = files(d);
  const target = path.join(d, 'target.toml'), link = path.join(d, 'link.toml');
  fs.writeFileSync(target, 'old\n'); fs.symlinkSync(target, link);
  const r = run(['extract', '--config', cfg, '-o', link]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(target, 'utf8'), LIVE);
});

test('BUG R7 extract backs up an existing output before overwriting it', (d) => {
  const { cfg, sh } = files(d);
  const r = run(['extract', '--config', cfg, '-o', sh]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.existsSync(sh + '.bak'), 'extract overwrote existing output without the required backup');
  assert.strictEqual(fs.readFileSync(sh + '.bak', 'utf8'), SHARED);
});
test('CMP R7 apply backs up an existing output before overwriting it', (d) => {
  const { cfg, sh } = files(d);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), LIVE);
});

test('BUG R8 reusing a backup honors the live file restriction to mode 0600', (d) => {
  const { cfg, sh } = files(d);
  fs.chmodSync(cfg, 0o600);
  fs.writeFileSync(cfg + '.bak', 'previous\n'); fs.chmodSync(cfg + '.bak', 0o644);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  const mode = fs.statSync(cfg + '.bak').mode & 0o777;
  assert.strictEqual(mode, 0o600, `backup mode is ${mode.toString(8)}, exposing the mode-0600 config`);
});
test('CMP R8 a new backup honors live mode 0600', (d) => {
  const { cfg, sh } = files(d);
  fs.chmodSync(cfg, 0o600);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.statSync(cfg + '.bak').mode & 0o777, 0o600);
});

test('BUG R9 a dotted key followed by a redefinition of its table is refused', (d) => {
  const { cfg, sh } = files(d, LIVE, 'mcp_servers.docs.command = "a"\n[mcp_servers.docs]\nargs = []\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 2, 'apply wrote a result that defines mcp_servers.docs twice');
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), LIVE);
  assert.ok(!fs.existsSync(cfg + '.bak'));
});
test('CMP R9 two explicit definitions of the same table are refused', (d) => {
  const { cfg, sh } = files(d, LIVE, '[mcp_servers.docs]\ncommand = "a"\n[mcp_servers.docs]\nargs = []\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 2, r.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), LIVE);
  assert.ok(!fs.existsSync(cfg + '.bak'));
});

test('BUG R10 one multiline dotted trust entry is counted once', (d) => {
  const { cfg, sh } = files(d, LIVE, 'projects."/x".trust_level = """\ntrusted"""\nmodel = "b"\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.err.includes('ignored 1 machine-local entry'), r.err.trim());
});
test('CMP R10 one single-line dotted trust entry is counted once', (d) => {
  const { cfg, sh } = files(d, LIVE, 'projects."/x".trust_level = "trusted"\nmodel = "b"\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.err.includes('ignored 1 machine-local entry'), r.err.trim());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
