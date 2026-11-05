// Lock recovery, competing reclaimers and host/PID namespace boundaries.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  BIN, PRELOAD, LOCK_PRELOAD, MCP_OLD, MCP_NEW, PROFILE_OLD, PROFILE_NEW, LIVE, test, files, run,
  contains, success, remedy, noLock, deadPid, namespace, putLock, held, finish,
} = require('./review-overlap-helpers');

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

for (const ns of ['pid:[foreign]', undefined]) {
  test(`foreign or missing PID namespace ${ns} refuses without probing its pid`, d => {
    const f = files(d);
    putLock(f.cfg, 42, os.hostname(), ns);
    // undefined must produce an old-format record, rather than putLock's default.
    if (ns === undefined) fs.writeFileSync(f.cfg + '.lock', JSON.stringify({pid:42, host:os.hostname()}));
    const lock = fs.readFileSync(f.cfg + '.lock');
    const r = run(f.mcp, { LOCK_CONFIG:f.cfg, LOCK_STAGE:'foreign-namespace' }, ['-r', LOCK_PRELOAD]);
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /lock busy/);
    assert.doesNotMatch(r.err, /must not probe/);
    assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), lock);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    remedy(r, f.cfg);
  });
}
test('real PID namespace holder above PID 1 remains foreign on the same hostname', async d => {
  const probe = spawnSync('unshare', ['-Urpf', '--mount-proc', process.execPath, '-e', ''], {encoding:'utf8'});
  if (probe.error || probe.status !== 0) {
    console.log(`     real unshare unavailable: ${probe.error?.message || probe.stderr.trim()}; injected namespace case still runs`);
    return;
  }
  const f = files(d), finish = await held(d, f.mcp, true);
  let r, owner, lock, first;
  try {
    lock = fs.readFileSync(f.cfg + '.lock');
    owner = JSON.parse(lock);
    assert.ok(owner.pid > 1, 'PID 1 would hide the bug because it is always visible');
    assert.throws(() => process.kill(owner.pid, 0), e => e.code === 'ESRCH', 'inner PID must be absent outside');
    console.log(`     real unshare holder PID ${owner.pid}, ${owner.namespace}`);
    assert.strictEqual(owner.host, os.hostname());
    assert.strictEqual(typeof owner.namespace, 'string');
    assert.notStrictEqual(owner.namespace, namespace());
    r = run(f.profile);
    assert.strictEqual(r.code, 2, r.err);
    assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), lock);
  } finally { first = await finish(); }
  success(first);
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
  noLock(f.cfg);
});
test('namespace absent on this platform is recorded as null and permits local recovery', d => {
  const f = files(d);
  putLock(f.cfg, deadPid(), os.hostname(), null);
  success(run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'no-namespace'}, ['-r', LOCK_PRELOAD]));
  noLock(f.cfg);
});
test('foreign namespace recovery links survive local cleanup', d => {
  const f = files(d);
  putLock(f.cfg, deadPid(), os.hostname(), 'pid:[foreign]');
  const r = spawnSync(process.execPath, ['-r', LOCK_PRELOAD, '-r', PRELOAD, BIN, ...f.mcp], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env,
      LOCK_CONFIG: f.cfg, LOCK_STAGE: 'namespace-foreign', OVERLAP_CONFIG: f.cfg, OVERLAP_STAGE: 'kill-reap' },
  });
  assert.ifError(r.error);
  assert.strictEqual(r.signal, 'SIGKILL', r.stderr);
  const claims = fs.readdirSync(d).filter(name => name.startsWith('config.toml.lock.reap-'));
  assert.strictEqual(claims.length, 1, 'the foreign reclaimer must leave its actual link');
  const claim = path.join(d, claims[0]), bytes = fs.readFileSync(claim);
  // The fixture reclaimer is now dead; remove its foreign lock to exercise local cleanup.
  fs.unlinkSync(f.cfg + '.lock');
  success(run(f.mcp));
  assert.deepStrictEqual(fs.readFileSync(claim), bytes);
});
test('a live holder inaccessible with EPERM is never reaped', d => {
  const f = files(d);
  putLock(f.cfg, 42);
  const lock = fs.readFileSync(f.cfg + '.lock');
  const r = run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'kill-eperm'}, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), lock);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  remedy(r, f.cfg);
});

test('a holder dying at the last recovery check allows one final acquisition', d => {
  const f = files(d);
  putLock(f.cfg, process.pid);
  success(run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'last-try'}, ['-r', LOCK_PRELOAD]));
  noLock(f.cfg);
});
test('distinct inode numbers above Number precision cannot authorize recovery', d => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  const lock = fs.readFileSync(f.cfg + '.lock');
  const r = run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'large-inode'}, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), lock);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
});

test('a dead lock in a read-only folder refuses recovery with the cause and remedy', d => {
  const f = files(d);
  putLock(f.cfg, deadPid());
  const lock = fs.readFileSync(f.cfg + '.lock');
  fs.chmodSync(d, 0o555);
  let r;
  try { r = run(f.mcp); } finally { fs.chmodSync(d, 0o700); }
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /EACCES/);
  remedy(r, f.cfg);
  assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), lock);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  success(run(f.mcp));
  noLock(f.cfg);
});
test('recovery open ENOENT after the holder releases retries acquisition', d => {
  const f = files(d);
  putLock(f.cfg, process.pid);
  success(run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'open-gone'}, ['-r', LOCK_PRELOAD]));
  noLock(f.cfg);
});


finish();
