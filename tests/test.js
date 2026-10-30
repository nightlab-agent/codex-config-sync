// Tests for codex-config-sync. Each case runs the real CLI on files in a fresh temp folder.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
let failed = 0, passed = 0;

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-')); }
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// A live config the way Codex leaves it: preferences, then trust tables it appended.
const LIVE = `model = "gpt-5.5"
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "docs-mcp",
]

[projects."/Users/ana/.dotfiles"]
trust_level = "trusted"

# work repo
[projects."/Users/ana/work/api"]
trust_level = "untrusted"
`;

const SHARED = `model = "gpt-5.5"
approval_policy = "never"
sandbox_mode = "workspace-write"

[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "docs-mcp",
]

[profiles.fast]
model = "gpt-5.5-mini"
`;

test('extract leaves out every [projects.*] table and the comment above one', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); fs.writeFileSync(cfg, LIVE);
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!r.out.includes('projects'), r.out);
  assert.ok(!r.out.includes('# work repo'), r.out);
  assert.ok(r.out.includes('[mcp_servers.docs]') && r.out.includes('"docs-mcp",'), r.out);
});

test('apply writes the shared preferences and keeps this machine\'s trust tables', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, SHARED);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  const out = fs.readFileSync(cfg, 'utf8');
  assert.ok(out.includes('approval_policy = "never"') && !out.includes('on-request'), out);
  assert.ok(out.includes('[profiles.fast]'), out);
  assert.ok(out.includes('[projects."/Users/ana/.dotfiles"]\ntrust_level = "trusted"'), out);
  assert.ok(out.includes('# work repo\n[projects."/Users/ana/work/api"]\ntrust_level = "untrusted"'), out);
  assert.strictEqual(fs.readFileSync(cfg + '.bak', 'utf8'), LIVE);
  assert.ok(/2 local entries kept/.test(r.out), r.out);
});

test('apply twice: the second run changes nothing', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, SHARED);
  run(['apply', sh, '--config', cfg]);
  const first = fs.readFileSync(cfg, 'utf8');
  const r = run(['apply', sh, '--config', cfg]);
  assert.ok(/already in sync/.test(r.out), r.out);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), first);
});

test('extract on one machine, apply on another: no trust table travels', () => {
  const d = dir(); const a = path.join(d, 'a.toml'); const b = path.join(d, 'b.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(a, LIVE);
  fs.writeFileSync(b, 'model = "old"\n\n[projects."/home/bo/src"]\ntrust_level = "trusted"\n');
  assert.strictEqual(run(['extract', '--config', a, '-o', sh]).code, 0);
  assert.strictEqual(run(['apply', sh, '--config', b]).code, 0);
  const out = fs.readFileSync(b, 'utf8');
  assert.ok(out.includes('/home/bo/src') && !out.includes('/Users/ana'), out);
  assert.ok(out.includes('model = "gpt-5.5"') && !out.includes('"old"'), out);
});

test('check: 0 when only trust tables differ, 1 with the changed line when a preference differs', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, LIVE.replace(/\[projects[\s\S]*/, ''));
  assert.strictEqual(run(['check', sh, '--config', cfg]).code, 0);
  fs.writeFileSync(sh, SHARED);
  const r = run(['check', sh, '--config', cfg]);
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.includes('- approval_policy = "on-request"') && r.out.includes('+ approval_policy = "never"'), r.out);
});

test('a "[" line inside a multi-line string or array is not a table header', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  const live = `developer_instructions = """
[projects."/not/a/table"]
keep me
"""
matrix = [
  ["a"],
  ["b"]
]

[projects."/real"]
trust_level = "trusted"
`;
  fs.writeFileSync(cfg, live);
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.includes('[projects."/not/a/table"]\nkeep me'), r.out);
  assert.ok(r.out.includes('  ["b"]\n]'), r.out);
  assert.ok(!r.out.includes('/real'), r.out);
  fs.writeFileSync(sh, 'model = "x"\n');
  run(['apply', sh, '--config', cfg]);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('[projects."/real"]'));
});

test('Windows paths in literal-string keys and CRLF line ends survive', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, "model = \"a\"\r\n\r\n[projects.'C:\\Users\\ana\\code']\r\ntrust_level = \"trusted\"\r\n");
  fs.writeFileSync(sh, 'model = "b"\n');
  assert.strictEqual(run(['apply', sh, '--config', cfg]).code, 0);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), "model = \"b\"\r\n\r\n[projects.'C:\\Users\\ana\\code']\r\ntrust_level = \"trusted\"\r\n");
});

test('root-level dotted trust keys stay above the first table', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, 'projects."/x".trust_level = "trusted"\nmodel = "a"\n');
  fs.writeFileSync(sh, 'model = "b"\n\n[tui]\nnotifications = true\n');
  assert.strictEqual(run(['apply', sh, '--config', cfg]).code, 0);
  const out = fs.readFileSync(cfg, 'utf8');
  assert.ok(out.indexOf('projects."/x"') < out.indexOf('[tui]'), out);
});

test('trust tables inside the shared file are ignored and reported', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, '[projects."/mine"]\ntrust_level = "trusted"\n');
  fs.writeFileSync(sh, 'model = "b"\n\n[projects."/mine"]\ntrust_level = "untrusted"\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(/ignored 1 machine-local entry/.test(r.err), r.err);
  const out = fs.readFileSync(cfg, 'utf8');
  assert.ok(out.includes('trust_level = "trusted"') && !out.includes('untrusted'), out);
});

test('--keep adds another per-machine key', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml');
  fs.writeFileSync(cfg, 'model = "a"\n\n[marketplaces.local]\nsource = "/Users/ana/mp"\n');
  const r = run(['extract', '--config', cfg, '--keep', 'projects', '--keep', 'marketplaces']);
  assert.ok(!r.out.includes('marketplaces'), r.out);
  assert.ok(run(['extract', '--config', cfg]).out.includes('marketplaces'));
});

test('a file it cannot split is refused and nothing is written', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, 'model = "unclosed\n');
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 2);
  assert.ok(/line 1/.test(r.err), r.err);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), LIVE);
  assert.ok(!fs.existsSync(cfg + '.bak'));
});

test('a live config that is a symlink is refused', () => {
  const d = dir(); const sh = path.join(d, 'shared.toml'); const cfg = path.join(d, 'config.toml');
  fs.writeFileSync(sh, SHARED); fs.symlinkSync(sh, cfg);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 2);
  assert.ok(/symlink/.test(r.err), r.err);
  assert.strictEqual(fs.readFileSync(sh, 'utf8'), SHARED);
});

test('CODEX_HOME picks the live config; a missing one is created', () => {
  const d = dir(); const sh = path.join(d, 'shared.toml'); fs.writeFileSync(sh, SHARED);
  const home = path.join(d, 'codex-home');
  const r = run(['apply', sh], { CODEX_HOME: home });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), SHARED);
});

test('--dry-run prints and writes nothing', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, SHARED);
  const r = run(['apply', sh, '--config', cfg, '--dry-run']);
  assert.ok(r.out.includes('[profiles.fast]') && r.out.includes('/Users/ana/.dotfiles'), r.out);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), LIVE);
});

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
