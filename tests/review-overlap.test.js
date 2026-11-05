// Two supported applies update separate tables; --keep makes the changes compatible.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const PRELOAD = path.join(__dirname, 'review-overlap-peer.js');
const ROOT = 'model = "base"\n';
const TRUST = '[projects."/work"]\ntrust_level = "trusted"';
const MCP_OLD = '[mcp_servers.docs]\ncommand = "docs-old"';
const MCP_NEW = '[mcp_servers.docs]\ncommand = "docs-new"';
const PROFILE_OLD = '[profiles.fast]\nmodel = "profile-old"';
const PROFILE_NEW = '[profiles.fast]\nmodel = "profile-new"';
const LIVE = ROOT + '\n' + [MCP_OLD, PROFILE_OLD, TRUST].join('\n\n') + '\n';
let passed = 0, failed = 0;

function test(name, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-overlap-'));
  try { fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function files(d) {
  const cfg = path.join(d, 'config.toml');
  const mcp = path.join(d, 'mcp.toml'), profile = path.join(d, 'profile.toml');
  fs.writeFileSync(cfg, LIVE);
  fs.writeFileSync(cfg + '.bak', 'model = "previous"\n');
  fs.writeFileSync(mcp, ROOT + '\n' + MCP_NEW + '\n');
  fs.writeFileSync(profile, ROOT + '\n' + PROFILE_NEW + '\n');
  return {
    cfg,
    mcp: ['apply', mcp, '--config', cfg, '--keep', 'projects', '--keep', 'profiles'],
    profile: ['apply', profile, '--config', cfg, '--keep', 'projects', '--keep', 'mcp_servers'],
  };
}
function run(args, env = {}, pre = []) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15000,
  });
  assert.ifError(r.error);
  assert.strictEqual(r.signal, null, `CLI killed by ${r.signal}`);
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function contains(text, mcp, profile) {
  for (const block of [ROOT.trim(), TRUST, mcp, profile]) assert.ok(text.includes(block), `missing ${block}\n${text}`);
  assert.strictEqual((text.match(/\[projects\."\/work"\]/g) || []).length, 1);
}
function success(r) { assert.strictEqual(r.code, 0, r.err); }
function successOrConflict(r) {
  if (r.code === 0) return;
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /concurrent|conflict|lock|busy|chang|another/i, 'refusal must explain the conflict');
}

for (const order of [['mcp', 'profile'], ['profile', 'mcp']]) {
  test(`CMP sequential ${order.join(' then ')} keeps both compatible updates`, (d) => {
    const f = files(d);
    for (const operation of order) success(run(f[operation]));
    const text = fs.readFileSync(f.cfg, 'utf8');
    contains(text, MCP_NEW, PROFILE_NEW);
    // Repeating the last operation is a no-op, including the backup.
    const backup = fs.readFileSync(f.cfg + '.bak', 'utf8');
    const r = run(f[order[1]]);
    success(r);
    assert.match(r.out, /already in sync/);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), text);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), backup);
  });
}

function overlap(d, stage) {
  const f = files(d), result = path.join(d, 'peer.json');
  const first = run(f.mcp, {
    OVERLAP_CONFIG: f.cfg, OVERLAP_STAGE: stage,
    OVERLAP_PEER_ARGS: JSON.stringify(f.profile), OVERLAP_RESULT: result,
  }, ['-r', PRELOAD]);
  assert.ok(fs.existsSync(result), 'the barrier must run the peer inside the first apply');
  const second = JSON.parse(fs.readFileSync(result, 'utf8'));
  assert.strictEqual(second.error, null, second.error);
  assert.strictEqual(second.signal, null);
  successOrConflict(first);
  successOrConflict(second);
  assert.ok(first.code === 0 || second.code === 0, 'at least one apply must complete');
  if (second.code === 0) {
    assert.match(second.out, /wrote /, 'the peer must commit before the first apply resumes');
    contains(second.committed, MCP_OLD, PROFILE_NEW);
    assert.strictEqual(second.backup, LIVE);
  } else {
    assert.strictEqual(second.committed, LIVE, 'a refused peer must leave the live config alone');
    assert.strictEqual(second.backup, 'model = "previous"\n');
  }
  const text = fs.readFileSync(f.cfg, 'utf8');
  if (first.code === 0 && second.code === 0) {
    const backup = fs.readFileSync(f.cfg + '.bak', 'utf8');
    assert.ok(text.includes(PROFILE_NEW),
      `both applies exited 0, but the peer's committed profile was lost; backup retains it: ${backup.includes(PROFILE_NEW)}`);
  }
  // Each successful writer's update must survive. A conflict may refuse a writer instead.
  contains(text, first.code === 0 ? MCP_NEW : MCP_OLD, second.code === 0 ? PROFILE_NEW : PROFILE_OLD);
  if (first.code !== 0) assert.strictEqual(text, second.committed, 'a refused first apply must keep the peer commit');
}

test('CMP a peer commit before the final check is merged or explicitly refused', (d) => overlap(d, 'before-check'));
test('BUG a peer commit during backup is kept or explicitly refused', (d) => overlap(d, 'during-backup'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
