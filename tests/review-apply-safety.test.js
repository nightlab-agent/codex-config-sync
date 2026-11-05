// Apply preflight, filesystem support, aliases and byte-exact backups.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LOCK_PRELOAD, ROOT, MCP_NEW, LIVE, test, files, run, success, remedy, noLock, deadPid, putLock,
  finish,
} = require('./review-overlap-helpers');

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
      assert.match(r.err, /exclusive create unsupported/);
      assert.match(r.err, /permissions|filesystem/i, 'lock creation refusal must suggest a remedy');
      noLock(f.cfg);
    } else {
      assert.match(r.err, /hard links unsupported/);
      remedy(r, f.cfg);
      fs.unlinkSync(f.cfg + '.lock');
      success(run(f.mcp));
      noLock(f.cfg);
    }
  });
}


for (const readOnly of [false, true]) {
  test(`symlinked live config retains advice with read-only folder ${readOnly}`, d => {
    const f = files(d), target = path.join(d, 'target.toml');
    fs.renameSync(f.cfg, target);
    fs.symlinkSync(target, f.cfg);
    if (readOnly) fs.chmodSync(d, 0o555);
    let r;
    try { r = run(f.mcp); } finally { fs.chmodSync(d, 0o700); }
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /symlink.*Replace the link with a plain file/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), LIVE);
    noLock(f.cfg);
  });
}
for (const kind of ['path', 'symlink', 'hardlink', 'folder-alias']) {
  test(`apply refuses shared file at its backup via ${kind} before either file changes`, d => {
    const f = files(d);
    const original = fs.readFileSync(f.cfg + '.bak');
    let shared = f.cfg + '.bak';
    if (kind === 'symlink' || kind === 'hardlink') {
      shared = path.join(d, 'alias.toml');
      if (kind === 'symlink') fs.symlinkSync(f.cfg + '.bak', shared);
      else fs.linkSync(f.cfg + '.bak', shared);
    } else if (kind === 'folder-alias') {
      fs.symlinkSync(d, path.join(d, 'alias'));
      shared = path.join(d, 'alias', 'config.toml.bak');
    }
    const r = run(['apply', shared, '--config', f.cfg]);
    assert.strictEqual(r.code, 2, r.err);
    assert.match(r.err, /backup/);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
    assert.deepStrictEqual(fs.readFileSync(f.cfg + '.bak'), original);
    assert.deepStrictEqual(fs.readFileSync(shared), original);
    noLock(f.cfg);
  });
}
for (const valid of [false, true]) {
  test(`UTF-8 valid ${valid}: apply preserves byte-exact backup or refuses unchanged`, d => {
    const f = files(d);
    const bytes = valid ? Buffer.from('model = "café"\r\n') : Buffer.concat([Buffer.from('model = "caf'), Buffer.from([0xe9]), Buffer.from('"\n')]);
    fs.writeFileSync(f.cfg, bytes);
    const r = run(f.mcp);
    if (valid) {
      success(r);
      assert.deepStrictEqual(fs.readFileSync(f.cfg + '.bak'), bytes);
    } else {
      assert.strictEqual(r.code, 2, r.err);
      assert.match(r.err, /UTF-8/);
      assert.deepStrictEqual(fs.readFileSync(f.cfg), bytes);
      assert.strictEqual(fs.readFileSync(f.cfg + '.bak', 'utf8'), 'model = "previous"\n');
    }
    noLock(f.cfg);
  });
}

for (const kind of ['path', 'symlink', 'hardlink']) {
  test(`shared file may still be live config via ${kind}`, d => {
    const f = files(d);
    let shared = f.cfg;
    if (kind !== 'path') {
      shared = path.join(d, 'same.toml');
      if (kind === 'symlink') fs.symlinkSync(f.cfg, shared); else fs.linkSync(f.cfg, shared);
    }
    const r = run(['apply', shared, '--config', f.cfg]);
    success(r);
    assert.match(r.out, /already in sync/);
    assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
  });
}

finish();
