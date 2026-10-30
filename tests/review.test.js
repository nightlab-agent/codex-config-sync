// Review tests for codex-config-sync (2026-10-30): each fault beside a case that already passed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const CODEX = process.env.CODEX_BIN; // optional: a codex binary to confirm Codex reads each result
const PRELOAD = path.join(__dirname, 'race-preload.js');
let failed = 0, passed = 0;

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-')); }
function run(args, env = {}, pre = []) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function codexAccepts(text) {
  if (!CODEX) return { ok: true, msg: 'not checked (set CODEX_BIN)' };
  const d = dir(); fs.writeFileSync(path.join(d, 'config.toml'), text);
  const r = spawnSync(CODEX, ['mcp', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: d } });
  return { ok: r.status === 0, msg: (r.stderr || '').split('\n').slice(0, 3).join(' | ') };
}
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// 1. A multi-line string whose closing line starts with "#" is taken for a comment above the next header.
const mlLive = (last) => `[agents.reviewer]
developer_instructions = """
Review the diff.
${last}"""
[projects."/home/ana/api"]
trust_level = "trusted"
`;
test('BUG extract keeps a multi-line string whose last line starts with # (before a local table)', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); fs.writeFileSync(cfg, mlLive('# Rules: be brief'));
  assert.ok(codexAccepts(mlLive('# Rules: be brief')).ok, 'input must be valid to Codex');
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  const v = codexAccepts(r.out);
  assert.ok(v.ok, `Codex rejects the extract output: ${v.msg}\n${r.out}`);
});
test('CMP extract keeps a multi-line string whose last line does not start with #', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); fs.writeFileSync(cfg, mlLive('Rules: be brief'));
  const r = run(['extract', '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  const v = codexAccepts(r.out);
  assert.ok(v.ok, `Codex rejects the extract output: ${v.msg}\n${r.out}`);
});

// 2. check trims line ends, so trailing spaces inside a multi-line string value are ignored.
const ms = (tail) => `[agents.reviewer]\ndeveloper_instructions = """\nline one${tail}\n"""\n`;
test('BUG check reports a difference inside a multi-line string value (trailing spaces)', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, ms('')); fs.writeFileSync(sh, ms('   '));
  const r = run(['check', sh, '--config', cfg]);
  assert.strictEqual(r.code, 1, `exit ${r.code}: ${r.out}`);
});
test('CMP check reports a difference inside a multi-line string value (one letter)', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, ms('')); fs.writeFileSync(sh, ms('x'));
  const r = run(['check', sh, '--config', cfg]);
  assert.strictEqual(r.code, 1, `exit ${r.code}: ${r.out}`);
});

// 3. apply reads the live config twice; a trust table Codex writes between the reads is lost.
const LIVE = 'model = "a"\n\n[projects."/old"]\ntrust_level = "trusted"\n';
const SHARED = 'model = "b"\n';
test('BUG apply keeps a trust table Codex wrote while apply was running', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(sh, SHARED);
  const r = run(['apply', sh, '--config', cfg], { RACE_CONFIG: cfg }, ['-r', PRELOAD]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('/new/repo'), 'trust for /new/repo is gone:\n' + fs.readFileSync(cfg, 'utf8'));
});
test('CMP apply keeps a trust table Codex wrote before apply started', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); const sh = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, LIVE + '\n[projects."/new/repo"]\ntrust_level = "trusted"\n'); fs.writeFileSync(sh, SHARED);
  const r = run(['apply', sh, '--config', cfg]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('/new/repo'));
});

// 4. extract -o onto a symlinked dotfiles file replaces the link instead of writing through it.
test('BUG extract -o writes through a symlinked dotfiles file', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); fs.writeFileSync(cfg, LIVE);
  const repo = path.join(d, 'repo.toml'); fs.writeFileSync(repo, 'old\n');
  const link = path.join(d, 'link.toml'); fs.symlinkSync(repo, link);
  const r = run(['extract', '--config', cfg, '-o', link]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(repo, 'utf8'), 'model = "a"\n', `repo file still: ${JSON.stringify(fs.readFileSync(repo, 'utf8'))}; link is symlink: ${fs.lstatSync(link).isSymbolicLink()}`);
});
test('CMP extract -o writes a plain file', () => {
  const d = dir(); const cfg = path.join(d, 'config.toml'); fs.writeFileSync(cfg, LIVE);
  const out = path.join(d, 'out.toml'); fs.writeFileSync(out, 'old\n');
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'model = "a"\n');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
