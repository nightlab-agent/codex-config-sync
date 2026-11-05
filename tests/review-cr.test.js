'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, spawn } = require('child_process');
const BIN = process.env.CR_BIN || path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const HOLD = path.join(__dirname, 'review-lock-preload.js'), MISC = path.join(__dirname, 'review-cr-misc-preload.js');
const base = process.env.CR_TMP || os.tmpdir();
const LIVE = 'model = "a"\n\n[t1]\nv = "old"\n\n[t2]\nv = "old"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
let passed = 0, failed = 0;
async function test(name, fn) {
  const d = fs.mkdtempSync(path.join(base, 'cr-'));
  try { await fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 5).join(' | ').slice(0, 420)}`); }
  finally { try { fs.chmodSync(d, 0o700); } catch {} fs.rmSync(d, { recursive: true, force: true }); }
}
function mk(d) {
  const cfg = d + '/config.toml';
  fs.writeFileSync(cfg, LIVE);
  fs.writeFileSync(d + '/s1.toml', 'model = "a"\n\n[t1]\nv = "new"\n');
  fs.writeFileSync(d + '/s2.toml', 'model = "a"\n\n[t2]\nv = "new"\n');
  return {
    cfg,
    a1: ['apply', d + '/s1.toml', '--config', cfg, '--keep', 'projects', '--keep', 't2'],
    a2: ['apply', d + '/s2.toml', '--config', cfg, '--keep', 'projects', '--keep', 't1'],
  };
}
function run(args, env = {}, pre = []) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function deadPid() { return spawnSync(process.execPath, ['-e', '']).pid; }
const waitFor = async (f) => {
  const end = Date.now() + 15000;
  while (!fs.existsSync(f)) {
    if (Date.now() > end) throw new Error('timeout ' + f);
    await new Promise((r) => setTimeout(r, 10));
  }
};
// Starts an apply and pauses it inside its commit, before the .bak rename, with its lock held.
async function held(d, args) {
  const ready = d + '/ready', release = d + '/release';
  let out = '', err = '';
  const c = spawn(process.execPath, ['-r', HOLD, BIN, ...args], {
    env: { ...process.env, LOCK_CONFIG: args[3], LOCK_STAGE: 'hold-backup', LOCK_READY: ready, LOCK_RELEASE: release },
  });
  c.stdout.on('data', (b) => { out += b; });
  c.stderr.on('data', (b) => { err += b; });
  const done = new Promise((res) => c.on('close', (code) => res({ code, out, err })));
  await waitFor(ready);
  return { pid: c.pid, finish: () => { fs.writeFileSync(release, 'go'); return done; } };
}
(async () => {
  await test('CMP A a holder that still owns its lock removes it at exit', async (d) => {
    const f = mk(d), h = await held(d, f.a1), r = await h.finish();
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(!fs.existsSync(f.cfg + '.lock'));
  });
  await test('BUG A a holder at exit leaves alone a lock that a later owner now holds', async (d) => {
    const f = mk(d), h = await held(d, f.a1);
    // The tool's own remedy, taken while A is paused; then a live owner C takes the name.
    fs.unlinkSync(f.cfg + '.lock');
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
    await h.finish();
    assert.ok(fs.existsSync(f.cfg + '.lock'), "holder A unlinked C's live lock by name");
  });
  await test('BUG B a write that landed reports success when the lock was already gone', async (d) => {
    const f = mk(d), h = await held(d, f.a1);
    fs.unlinkSync(f.cfg + '.lock');
    const r = await h.finish();
    assert.ok(fs.readFileSync(f.cfg, 'utf8').includes('v = "new"'), 'write landed');
    assert.strictEqual(r.code, 0, `exit ${r.code} after printing ${JSON.stringify(r.out)}; stderr ${r.err}`);
  });
  await test('BUG B2 a refusal keeps its own reason when the lock was already gone', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg, 'model = "unterminated\n');
    const pre = d + '/gone.js';
    fs.writeFileSync(pre, `const fs=require('fs');const r=fs.readFileSync,c=${JSON.stringify(f.cfg)};
      fs.readFileSync=function(p,...a){if(p===c&&fs.existsSync(c+'.lock'))fs.unlinkSync(c+'.lock');return r.call(this,p,...a);};`);
    const r = run(f.a1, {}, ['-r', pre]);
    assert.match(r.err, /string not closed/, r.err);
  });
  await test('CMP C a lock held by a process this one can see is respected', async (d) => {
    const f = mk(d), h = await held(d, f.a1), r = run(f.a2);
    await h.finish();
    assert.strictEqual(r.code, 2, r.err);
    const t = fs.readFileSync(f.cfg, 'utf8');
    assert.match(t, /\[t1\]\nv = "new"/);
    assert.match(t, /\[t2\]\nv = "old"/);
  });
  await test('BUG C (model) same hostname, another PID space: both exit 0 and both changes stay', async (d) => {
    const f = mk(d), h = await held(d, f.a1);
    const r = run(f.a2, { CR_STAGE: 'other-pid-space', CR_HOLDER: String(h.pid) }, ['-r', MISC]);
    const a = await h.finish();
    const t = fs.readFileSync(f.cfg, 'utf8');
    assert.strictEqual(r.code, 0, r.err);
    assert.match(t, /\[t1\]\nv = "new"/, 't1');
    assert.match(t, /\[t2\]\nv = "new"/, `the peer exited 0 and printed ${r.out.slice(0, 5)}; its [t2] is lost; holder exit ${a.code}; live: ${t.replace(/\n/g, ' ')}`);
  });
  await test('CMP D a holder dead before the first try is recovered', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    const r = run(f.a1);
    assert.strictEqual(r.code, 0, r.err);
  });
  await test('BUG D a holder dead at the last try: the lock it recovers is used, not refused', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const r = run(f.a1, { CR_STAGE: 'dies-on-last-try', CR_CONFIG: f.cfg, CR_DEAD: String(deadPid()) }, ['-r', MISC]);
    assert.strictEqual(r.code, 0, `exit ${r.code}; lock exists after refusal: ${fs.existsSync(f.cfg + '.lock')}; ${r.err.slice(-260)}`);
  });
  await test('CMP E a busy lock names the remedy', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const r = run(f.a1);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /Only then remove/);
  });
  await test('BUG E a lock this user cannot read (left by another account) names the remedy too', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    fs.chmodSync(f.cfg + '.lock', 0);
    const r = run(f.a1);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /Only then remove/, r.err);
  });
  await test('BUG E2 a dead lock in a read-only folder names the remedy too', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    fs.chmodSync(d, 0o555);
    const r = run(f.a1);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /Only then remove/, r.err);
  });
  await test('CMP F extract refuses a .bak that is the live config (the 0.1.1 guard)', async (d) => {
    const cfg = d + '/x.bak';
    fs.writeFileSync(cfg, 'model = "a"\n');
    fs.writeFileSync(d + '/x', 'old\n');
    const r = run(['extract', '-o', d + '/x', '--config', cfg]);
    assert.strictEqual(r.code, 2, r.err);
  });
  await test('BUG F apply does not replace the shared file it was given (shared is <config>.bak)', async (d) => {
    const f = mk(d), shared = f.cfg + '.bak';
    const own = 'model = "from-backup"\n\n[projects."/old"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(shared, own);
    const r = run(['apply', shared, '--config', f.cfg]);
    const gone = !fs.readFileSync(shared, 'utf8').includes('/old') && !fs.readFileSync(f.cfg, 'utf8').includes('/old');
    assert.ok(r.code === 2 || fs.readFileSync(shared, 'utf8') === own, `exit ${r.code}, the shared file was replaced; [projects."/old"] now nowhere: ${gone}`);
  });
  await test('CMP G symlinked config: lock lands beside the link, refused, target and lock clean', async (d) => {
    const f = mk(d);
    fs.mkdirSync(d + '/real');
    fs.renameSync(f.cfg, d + '/real/c.toml');
    fs.symlinkSync(d + '/real/c.toml', f.cfg);
    const r = run(f.a1);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /symlink/);
    assert.deepStrictEqual(fs.readdirSync(d + '/real'), ['c.toml']);
    assert.strictEqual(fs.readFileSync(d + '/real/c.toml', 'utf8'), LIVE);
    assert.ok(!fs.existsSync(f.cfg + '.lock'));
  });
  await test('BUG G1 a symlinked config in a read-only folder gets the symlink refusal, as in 0.1.1', async (d) => {
    const f = mk(d);
    fs.mkdirSync(d + '/real');
    fs.renameSync(f.cfg, d + '/real/c.toml');
    fs.symlinkSync(d + '/real/c.toml', f.cfg);
    fs.chmodSync(d, 0o555);
    const r = run(f.a1);
    assert.match(r.err, /symlink/, r.err);
  });
  await test('CMP G2 one folder under two names shares one lock', async (d) => {
    fs.mkdirSync(d + '/real');
    const f = mk(d + '/real');
    fs.symlinkSync(d + '/real', d + '/alias');
    const h = await held(d + '/real', f.a1);
    const r = run(['apply', d + '/real/s2.toml', '--config', d + '/alias/config.toml', '--keep', 'projects', '--keep', 't1']);
    await h.finish();
    assert.strictEqual(r.code, 2, r.err);
  });
  await test('CMP G3 shared file is the live config by path, link and hard link: every setting kept', async (d) => {
    for (const kind of ['path', 'sym', 'hard']) {
      const f = mk(d);
      let s = f.cfg;
      if (kind === 'sym') { s = d + '/sym'; fs.symlinkSync(f.cfg, s); }
      if (kind === 'hard') { s = d + '/hard'; fs.linkSync(f.cfg, s); }
      const r = run(['apply', s, '--config', f.cfg]);
      assert.strictEqual(r.code, 0, r.err);
      assert.strictEqual(fs.readFileSync(f.cfg, 'utf8'), LIVE);
      assert.match(r.out, /already in sync/);
    }
  });
  await test('CMP H valid UTF-8 outside ASCII survives apply byte for byte', async (d) => {
    const f = mk(d);
    const b = Buffer.from('model = "a"\n\n[projects."/home/café"]\ntrust_level = "trusted"\n');
    fs.writeFileSync(f.cfg, b);
    fs.writeFileSync(d + '/s.toml', 'model = "b"\n');
    const r = run(['apply', d + '/s.toml', '--config', f.cfg]);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(fs.readFileSync(f.cfg).includes('café'));
    assert.ok(fs.readFileSync(f.cfg + '.bak').equals(b));
  });
  await test('BUG H a Latin-1 path in a trust table is refused, or the .bak holds the old bytes', async (d) => {
    const f = mk(d);
    const b = Buffer.concat([Buffer.from('model = "a"\n\n[projects."/home/caf'), Buffer.from([0xe9]), Buffer.from('"]\ntrust_level = "trusted"\n')]);
    fs.writeFileSync(f.cfg, b);
    fs.writeFileSync(d + '/s.toml', 'model = "b"\n');
    const r = run(['apply', d + '/s.toml', '--config', f.cfg]);
    assert.ok(r.code === 2 || fs.readFileSync(f.cfg + '.bak').equals(b), `exit ${r.code}; .bak bytes ${fs.readFileSync(f.cfg + '.bak').slice(24, 38).toString('hex')} wanted ${b.slice(24, 38).toString('hex')}`);
  });
  await test('CMP I a release that lands at open lets the waiter proceed', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const r = run(f.a1, { CR_CONFIG: f.cfg, CR_AT: 'open' }, ['-r', path.join(__dirname, 'review-cr-fstat-preload.js')]);
    assert.strictEqual(r.code, 0, r.err);
  });
  await test('BUG I a release that lands at fstat lets the waiter proceed too', async (d) => {
    const f = mk(d);
    fs.writeFileSync(f.cfg + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const r = run(f.a1, { CR_CONFIG: f.cfg, CR_AT: 'fstat' }, ['-r', path.join(__dirname, 'review-cr-fstat-preload.js')]);
    assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.err.trim()}`);
  });
  await test('CMP J a holder of another account (EPERM, pid 1) is never taken over', async (d) => {
    const f = mk(d);
    const rec = JSON.stringify({ pid: 1, host: os.hostname() });
    fs.writeFileSync(f.cfg + '.lock', rec);
    const r = run(f.a1);
    assert.strictEqual(r.code, 2, r.err);
    assert.strictEqual(fs.readFileSync(f.cfg + '.lock', 'utf8'), rec);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
