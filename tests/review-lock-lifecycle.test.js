// Lock acquisition, release ownership, refusals and interrupted applies.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  BIN, LOCK_PRELOAD, MCP_NEW, PROFILE_OLD, LIVE, test, files, run, contains, success, noLock,
  namespace, putLock, held, finish,
} = require('./review-overlap-helpers');

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

for (const changed of ['replaced', 'gone', 'ours']) {
  test(`release after commit when lock is ${changed} preserves ownership and success`, async d => {
    const f = files(d), finish = await held(d, f.mcp);
    let r, other, owner;
    try {
      owner = JSON.parse(fs.readFileSync(f.cfg + '.lock', 'utf8'));
      if (changed !== 'ours') fs.unlinkSync(f.cfg + '.lock');
      if (changed === 'replaced') {
        putLock(f.cfg, process.pid);
        other = fs.readFileSync(f.cfg + '.lock');
      }
    } finally { r = await finish(); }
    success(r);
    assert.strictEqual(owner.namespace, namespace(), 'record must identify the PID namespace');
    contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
    if (other) assert.deepStrictEqual(fs.readFileSync(f.cfg + '.lock'), other);
    else noLock(f.cfg);
  });
}
for (const stage of ['unlock-gone', 'unlock-error']) {
  test(`refusal retains its parse reason despite ${stage}`, d => {
    const f = files(d);
    fs.writeFileSync(f.cfg, 'model = "unterminated\n');
    const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: stage }, ['-r', LOCK_PRELOAD]);
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /string not closed/);
    if (stage === 'unlock-error') assert.match(r.err, /injected unlock failure/);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), 'model = "unterminated\n');
    assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
    if (stage === 'unlock-gone') noLock(f.cfg);
  });
}

test('failed partial lock-record write removes our lock and preserves the original error', d => {
  const f = files(d);
  const r = run(f.mcp, {LOCK_CONFIG:f.cfg, LOCK_STAGE:'record-error'}, ['-r', LOCK_PRELOAD]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /injected record write failure/);
  assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  noLock(f.cfg);
  success(run(f.mcp));
});

test('one folder under two names still shares one busy lock', async d => {
  const f = files(d), finish = await held(d, f.mcp);
  fs.symlinkSync(d, path.join(d, 'alias'));
  let r;
  try { r = run(['apply', f.profile[1], '--config', path.join(d, 'alias', 'config.toml')]); }
  finally { success(await finish()); }
  assert.strictEqual(r.code, 2, r.err);
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
});

test('lock disappearing between the release stat and unlink still reports a committed apply', d => {
  const f = files(d);
  const r = run(f.mcp, { LOCK_CONFIG: f.cfg, LOCK_STAGE: 'unlink-gone' }, ['-r', LOCK_PRELOAD]);
  success(r);
  contains(fs.readFileSync(f.cfg, 'utf8'), MCP_NEW, PROFILE_OLD);
  assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), LIVE);
  noLock(f.cfg);
});

finish();
