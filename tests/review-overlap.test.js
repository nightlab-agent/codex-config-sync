// Two supported applies update separate tables; --keep makes the changes compatible.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const PRELOAD = path.join(__dirname, 'review-overlap-peer.js');
const LOCK_PRELOAD = path.join(__dirname, 'review-lock-preload.js');
const ROOT = 'model = "base"\n';
const TRUST = '[projects."/work"]\ntrust_level = "trusted"';
const MCP_OLD = '[mcp_servers.docs]\ncommand = "docs-old"';
const MCP_NEW = '[mcp_servers.docs]\ncommand = "docs-new"';
const PROFILE_OLD = '[profiles.fast]\nmodel = "profile-old"';
const PROFILE_NEW = '[profiles.fast]\nmodel = "profile-new"';
const LIVE = ROOT + '\n' + [MCP_OLD, PROFILE_OLD, TRUST].join('\n\n') + '\n';
let passed = 0, failed = 0;
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-overlap-'));
    try { await fn(d); passed++; console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
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
function remedy(r, cfg) {
  assert.match(r.err, /check that no apply is still running on any host/i, 'refusal must explain what to check');
  assert.ok(r.err.includes(`Only then remove ${cfg}.lock and run apply again`), r.err);
}
function noLock(cfg) {
  assert.deepStrictEqual(fs.readdirSync(path.dirname(cfg)).filter((f) => f.startsWith(path.basename(cfg) + '.lock')), []);
}
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.throws(() => process.kill(r.pid, 0), (e) => e.code === 'ESRCH');
  return r.pid;
}
function putLock(cfg, pid, host = os.hostname()) {
  fs.writeFileSync(cfg + '.lock', JSON.stringify({ pid, host }));
}
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
    noLock(f.cfg);
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
  noLock(f.cfg);
}

test('CMP a peer commit before the final check is merged or explicitly refused', (d) => overlap(d, 'before-check'));
test('BUG a peer commit during backup is kept or explicitly refused', (d) => overlap(d, 'during-backup'));

test('BUG apply owns the lock before its first live read and removes it after success', (d) => {
  const f = files(d);
  success(run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'locked-read' }, ['-r', LOCK_PRELOAD]));
  noLock(f.cfg);
});
test('BUG shared file naming the live config is also read only after locking', (d) => {
  const f = files(d);
  success(run(['apply', f.cfg, '--config', f.cfg],
    { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'locked-read' }, ['-r', LOCK_PRELOAD]));
  noLock(f.cfg);
});
test('BUG a live holder past the wait refuses apply with its path and holder, without writing', (d) => {
  const f = files(d);
  putLock(f.cfg, process.pid);
  const lock = fs.readFileSync(f.cfg + '.lock', 'utf8');
  const start = Date.now(), r = run(f.mcp), elapsed = Date.now() - start;
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(elapsed >= 400 && elapsed < 5000, `bounded wait took ${elapsed} ms`);
  for (const text of [f.cfg + '.lock', String(process.pid), os.hostname()]) assert.ok(r.err.includes(text), r.err);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
  assert.strictEqual(fs.readFileSync(f.cfg + '.lock', 'utf8'), lock, 'a refused contender must not release another owner');
  fs.unlinkSync(f.cfg + '.lock');
  success(run(f.mcp));
  noLock(f.cfg);
});
test('CMP a lock from a provably dead local pid is recovered without a manual step', (d) => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  success(run(f.mcp));
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
  noLock(f.cfg);
});
test('BUG fstat ENOENT after a holder removes its lock retries acquisition', (d) => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  success(run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'stat-gone' }, ['-r', LOCK_PRELOAD]));
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), LIVE);
  noLock(f.cfg);
});
test('BUG other fstat errors refuse with a recovery step and keep the lock', (d) => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  const lock = fs.readFileSync(f.cfg + '.lock', 'utf8');
  const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'stat-error' }, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /injected recovery fstat failure/);
  remedy(r, f.cfg);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
  assert.strictEqual(fs.readFileSync(f.cfg + '.lock', 'utf8'), lock);
  success(run(f.mcp));
  noLock(f.cfg);
});
test('BUG an unreadable lock refuses with a recovery step without changing any file', (d) => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  const lock = fs.readFileSync(f.cfg + '.lock', 'utf8');
  fs.chmodSync(f.cfg + '.lock', 0o000);
  try {
    const r = run(f.mcp);
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /EACCES/);
    remedy(r, f.cfg);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
  } finally { fs.chmodSync(f.cfg + '.lock', 0o600); }
  assert.strictEqual(fs.readFileSync(f.cfg + '.lock', 'utf8'), lock);
  success(run(f.mcp));
  noLock(f.cfg);
});
for (const owner of ['foreign', 'unknown', 'truncated', 'invalid']) {
  test(`BUG ${owner} ownership is refused, never guessed dead`, (d) => {
    const f = files(d);
    if (owner === 'foreign') putLock(f.cfg, deadPid(), os.hostname() + '-other');
    else fs.writeFileSync(f.cfg + '.lock', owner === 'truncated' ? '{"pid":' : owner === 'invalid' ? '{}' : '');
    const lock = fs.readFileSync(f.cfg + '.lock', 'utf8');
    const r = run(f.mcp);
    assert.strictEqual(r.code, 2, r.err);
    assert.ok(r.err.includes(f.cfg + '.lock'), r.err);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
    assert.strictEqual(fs.readFileSync(f.cfg + '.lock', 'utf8'), lock);
    remedy(r, f.cfg);
    // These fixture locks have no owner; follow the remedy and confirm retry heals.
    fs.unlinkSync(f.cfg + '.lock');
    success(run(f.mcp));
    noLock(f.cfg);
  });
}
for (const stage of ['before-reap', 'during-reap']) {
  test(`BUG two processes recovering a lock at ${stage} preserve each successful update`, (d) => {
    const f = files(d), result = path.join(d, 'peer.json');
    putLock(f.cfg, deadPid());
    success(run(f.mcp, {
      OVERLAP_CONFIG: f.cfg, OVERLAP_STAGE: stage,
      OVERLAP_PEER_ARGS: JSON.stringify(f.profile), OVERLAP_RESULT: result,
    }, ['-r', PRELOAD]));
    assert.ok(fs.existsSync(result), 'the stale-recovery barrier must run');
    const second = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.strictEqual(second.error, null, second.error);
    assert.strictEqual(second.signal, null);
    if (stage === 'before-reap') success(second);
    else {
      assert.strictEqual(second.code, 2, second.err);
      assert.ok(second.err.includes(f.cfg + '.lock'), second.err);
    }
    contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, second.code === 0 ? PROFILE_NEW : PROFILE_OLD);
    noLock(f.cfg);
  });
}
test('BUG a delayed stale observer cannot remove a new live owner\'s lock', (d) => {
  const f = files(d), result = path.join(d, 'peer.json');
  putLock(f.cfg, deadPid());
  const first = run(f.mcp, {
    OVERLAP_CONFIG: f.cfg, OVERLAP_STAGE: 'stale-then-live',
    OVERLAP_PEER_ARGS: JSON.stringify(f.profile), OVERLAP_RESULT: result,
  }, ['-r', PRELOAD]);
  assert.ok(fs.existsSync(result), 'the stale observer must overlap the live peer');
  const second = JSON.parse(fs.readFileSync(result, 'utf8'));
  assert.strictEqual(second.error, null, second.error);
  assert.strictEqual(second.signal, null);
  success(second);
  assert.strictEqual(first.code, 2, first.err);
  assert.ok(first.err.includes(f.cfg + '.lock'), first.err);
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_OLD, PROFILE_NEW);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), LIVE);
  noLock(f.cfg);
});
for (const stage of ['kill-reap', 'kill-after-reap']) {
  test(`BUG ${stage}: the next apply cleans the abandoned recovery link and heals`, (d) => {
    const f = files(d);
    putLock(f.cfg, deadPid());
    const r = spawnSync(process.execPath, ['-r', PRELOAD, BIN, ...f.mcp], {
      encoding: 'utf8', env: { ...process.env, OVERLAP_CONFIG: f.cfg, OVERLAP_STAGE: stage }, timeout: 10000,
    });
    assert.strictEqual(r.signal, 'SIGKILL', r.stderr);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    success(run(f.mcp));
    noLock(f.cfg);
  });
}
test('BUG refused apply releases its own lock after a SplitError', (d) => {
  const f = files(d);
  fs.writeFileSync(f.cfg, 'model = "unterminated\n');
  const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'locked-read' }, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  noLock(f.cfg);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), 'model = "unterminated\n');
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
});
test('BUG refused apply releases its own lock after a write error', (d) => {
  const f = files(d);
  fs.unlinkSync(f.cfg + '.bak');
  fs.mkdirSync(f.cfg + '.bak'); // a backup cannot replace a directory
  const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'locked-read' }, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  noLock(f.cfg);
});
for (const stop of [1, 2]) {
  test(`BUG apply killed before rename ${stop}: lock is recovered and retry heals`, (d) => {
    const f = files(d);
    const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'review-link-kill.js'), BIN, ...f.mcp], {
      encoding: 'utf8', env: { ...process.env, LINK_REVIEW_KILL_RENAME: String(stop) }, timeout: 10000,
    });
    assert.strictEqual(r.signal, 'SIGKILL', r.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(f.cfg + '.lock', 'utf8')).pid, r.pid);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), stop === 1 ? 'model = "previous"\n' : LIVE);
    success(run(f.mcp));
    contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), LIVE);
    noLock(f.cfg);
  });
}
test('CMP dry-run, extract and check never acquire a lock, even with a live holder', (d) => {
  const f = files(d);
  const commands = [[...f.mcp, '--dry-run'], ['extract', '--config', f.cfg], ['check', f.mcp[1], '--config', f.cfg]];
  for (const held of [false, true]) {
    if (held) putLock(f.cfg, process.pid);
    for (const args of commands) {
      const r = run(args, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'no-lock' }, ['-r', LOCK_PRELOAD]);
      assert.strictEqual(r.code, args[0] === 'check' ? 1 : 0, r.err);
    }
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    if (held) fs.unlinkSync(f.cfg + '.lock');
    noLock(f.cfg);
  }
});
test('BUG read-only config folder refuses even a no-op apply without leaving a lock', (d) => {
  const f = files(d);
  fs.chmodSync(d, 0o555);
  try {
    const r = run(['apply', f.cfg, '--config', f.cfg]);
    assert.strictEqual(r.code, 2, r.err);
    assert.ok(r.err.includes(f.cfg + '.lock'), r.err);
    assert.match(r.err, /permissions|exclusive create/i, 'lock creation refusal must suggest a remedy');
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    noLock(f.cfg);
  } finally { fs.chmodSync(d, 0o700); }
});
for (const sharedKind of ['missing', 'dangling', 'malformed', 'duplicate']) {
  test(`BUG ${sharedKind} shared file refuses apply without creating the config folder`, (d) => {
    const cfg = path.join(d, 'new', 'nested', 'config.toml'), shared = path.join(d, 'shared.toml');
    if (sharedKind === 'dangling') fs.symlinkSync(path.join(d, 'absent.toml'), shared);
    if (sharedKind === 'malformed') fs.writeFileSync(shared, 'model = "unterminated\n');
    if (sharedKind === 'duplicate') fs.writeFileSync(shared, '[x]\ny = 1\n[x]\nz = 2\n');
    const before = fs.readdirSync(d).sort();
    const r = run(['apply', shared, '--config', cfg]);
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /no shared file|string not closed|define \[x\] twice/);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), before, 'refused apply must not create the config folder');
  });
}
test('BUG missing shared file refuses before locking an existing config folder', (d) => {
  const f = files(d), shared = path.join(d, 'missing.toml');
  const r = run(['apply', shared, '--config', f.cfg],
    { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'no-lock' }, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(r.err.includes(`no shared file at ${shared}`), r.err);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
  noLock(f.cfg);
});
test('CMP a missing config folder is created before locking and the lock is removed', (d) => {
  const f = files(d), cfg = path.join(d, 'new', 'nested', 'config.toml');
  success(run(['apply', f.mcp[1], '--config', cfg]));
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), ROOT + '\n' + MCP_NEW + '\n');
  assert.ok(!fs.existsSync(cfg + '.bak'));
  noLock(cfg);
});
for (const stage of ['no-exclusive', 'no-links']) {
  test(`BUG filesystem with ${stage} refuses without changing live config or backup`, (d) => {
    const f = files(d);
    if (stage === 'no-links') putLock(f.cfg, deadPid());
    const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: stage }, ['-r', LOCK_PRELOAD]);
    assert.strictEqual(r.code, 2, r.err);
    assert.ok(r.err.includes(f.cfg + '.lock'), r.err);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
    if (stage === 'no-exclusive') {
      assert.match(r.err, /exclusive create/);
      assert.match(r.err, /permissions|filesystem/i, 'lock creation refusal must suggest a remedy');
      noLock(f.cfg);
    } else {
      remedy(r, f.cfg);
      fs.unlinkSync(f.cfg + '.lock');
      success(run(f.mcp));
      noLock(f.cfg);
    }
  });
}

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

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
});
