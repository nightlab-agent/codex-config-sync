// Gate review of the link walk (92d8e64): each suspected fault beside its nearest passing comparison,
// and the four questions (twice, two at once, dies halfway, the real system) on extract -o.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
const KILL = path.join(__dirname, 'review-link-kill.js');
const LIVE = 'model = "new"\n';
const TRUST = 'model = "a"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
let passed = 0, failed = 0;
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-link-'));
    try { await fn(d); passed++; console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
}
function run(args, env = {}, pre = []) {
  const r = spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, signal: r.signal };
}
// What the kernel does with a write through the link: 'writes' or the errno.
function osWrite(link) {
  try { fs.closeSync(fs.openSync(link, 'w')); return 'writes'; } catch (e) { return e.code; }
}

// --- L1: a link text that ends in a separator (or /.) names a directory to the kernel (path_resolution(7),
// "Trailing slashes"); the walk drops the empty part and writes the file the kernel refuses ---
function extractThrough(d, linkText) {
  const target = path.join(d, 'target.toml');
  fs.writeFileSync(target, 'old\n');
  const out = path.join(d, 'out.toml');
  fs.symlinkSync(linkText, out);
  const os_ = osWrite(out);
  fs.writeFileSync(target, 'old\n'); // the probe may have truncated it
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, LIVE);
  const r = run(['extract', '--config', cfg, '-o', out]);
  return { r, os_, target };
}
for (const text of ['target.toml/', 'target.toml/.', 'target.toml/./']) {
  test(`BUG L1 a link to "${text}": the kernel refuses the write, the tool writes target.toml`, (d) => {
    const { r, os_, target } = extractThrough(d, text);
    assert.notStrictEqual(os_, 'writes', 'the OS must refuse this path');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old\n', `OS says ${os_}; the tool wrote target.toml (exit ${r.code})`);
    assert.notStrictEqual(r.code, 0, 'extract must refuse where the OS refuses');
  });
}
test('BUG L1b a dangling link with a trailing slash: the kernel refuses, the tool creates the missing file', (d) => {
  fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'dangling'));
  const out = path.join(d, 'out.toml');
  fs.symlinkSync('dangling/', out);
  const os_ = osWrite(out);
  assert.notStrictEqual(os_, 'writes');
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, LIVE);
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.ok(!fs.existsSync(path.join(d, 'nowhere')), `OS says ${os_}; the tool created nowhere (exit ${r.code})`);
  assert.notStrictEqual(r.code, 0);
});
test('CMP L1 a link to "target.toml" (no trailing slash): both write target.toml', (d) => {
  const { r, os_, target } = extractThrough(d, 'target.toml');
  assert.strictEqual(os_, 'writes');
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), LIVE);
});
test('CMP L1 a link to "sub/" (a folder): both refuse', (d) => {
  fs.mkdirSync(path.join(d, 'sub'));
  const { r, os_ } = extractThrough(d, 'sub/');
  assert.strictEqual(os_, 'EISDIR');
  assert.strictEqual(r.code, 2, r.err);
});

// --- L2: extract -o aimed at the live config (a stow-style ~/.codex/config.toml -> dotfiles link, or the same path)
// strips the trust tables from the live file; apply refuses that link, extract follows it ---
test('BUG L2 extract -o onto the file the live config links to drops the live trust tables', (d) => {
  fs.mkdirSync(path.join(d, 'dotfiles')); fs.mkdirSync(path.join(d, 'codex'));
  const shared = path.join(d, 'dotfiles', 'config.toml');
  fs.writeFileSync(shared, TRUST);
  const cfg = path.join(d, 'codex', 'config.toml');
  fs.symlinkSync(shared, cfg);
  const r = run(['extract', '--config', cfg, '-o', shared]);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('[projects."/x"]'),
    `the live config lost its trust table (exit ${r.code}, stderr: ${r.err.trim()})`);
});
test('BUG L2b extract -o naming the live config itself drops its trust tables', (d) => {
  const cfg = path.join(d, 'config.toml');
  fs.writeFileSync(cfg, TRUST);
  const r = run(['extract', '--config', cfg, '-o', cfg]);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('[projects."/x"]'),
    `the live config lost its trust table (exit ${r.code}, stderr: ${r.err.trim()})`);
});
test('BUG L3 extract -o whose backup name is the live config drops its trust tables', (d) => {
  const live = path.join(d, 'out.toml.bak');
  fs.writeFileSync(live, TRUST);
  fs.writeFileSync(path.join(d, 'out.toml'), 'old = 1\n');
  const r = run(['extract', '--config', live, '-o', path.join(d, 'out.toml')]);
  assert.strictEqual(fs.readFileSync(live, 'utf8'), TRUST, `the live config was replaced (exit ${r.code})`);
  assert.strictEqual(r.code, 2);
});
test('BUG L3b the same through a link at the live config', (d) => {
  const real = path.join(d, 'out.toml.bak');
  const cfg = path.join(d, 'config.toml');
  fs.writeFileSync(real, TRUST);
  fs.symlinkSync(real, cfg);
  fs.writeFileSync(path.join(d, 'out.toml'), 'old = 1\n');
  const r = run(['extract', '--config', cfg, '-o', path.join(d, 'out.toml')]);
  assert.strictEqual(fs.readFileSync(real, 'utf8'), TRUST, `the live config was replaced (exit ${r.code})`);
  assert.strictEqual(r.code, 2);
});
test('CMP L2 extract -o to another file keeps the live trust tables', (d) => {
  const cfg = path.join(d, 'config.toml'), out = path.join(d, 'shared.toml');
  fs.writeFileSync(cfg, TRUST);
  const r = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('[projects."/x"]'));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'model = "a"\n');
});

// --- Q1: runs twice ---
test('CMP Q1 extract -o twice: the second .bak is the first output (one copy, as the README says)', (d) => {
  const cfg = path.join(d, 'live.toml'), out = path.join(d, 'out.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(out, 'original\n');
  assert.strictEqual(run(['extract', '--config', cfg, '-o', out]).code, 0);
  assert.strictEqual(fs.readFileSync(out + '.bak', 'utf8'), 'original\n');
  assert.strictEqual(run(['extract', '--config', cfg, '-o', out]).code, 0);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), LIVE);
  assert.strictEqual(fs.readFileSync(out + '.bak', 'utf8'), LIVE);
  assert.deepStrictEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
});

// --- Q2: two at once on the same -o (different pids, so different temp names) ---
test('CMP Q2 twenty extracts at once onto one link: the target holds the text whole, no temp file left', (d) => {
  const cfg = path.join(d, 'live.toml'), target = path.join(d, 'target.toml'), out = path.join(d, 'out.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(target, 'original\n'); fs.symlinkSync('target.toml', out);
  const kids = [];
  for (let i = 0; i < 20; i++) {
    kids.push(new Promise((res) => {
      const c = spawn(process.execPath, [BIN, 'extract', '--config', cfg, '-o', out], { stdio: 'ignore' });
      c.on('exit', (code) => res(code));
    }));
  }
  return Promise.all(kids).then((codes) => {
    assert.deepStrictEqual(codes, Array(20).fill(0), `exit codes ${codes}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), LIVE);
    assert.ok(['original\n', LIVE].includes(fs.readFileSync(target + '.bak', 'utf8')));
    assert.deepStrictEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
    assert.ok(fs.lstatSync(out).isSymbolicLink(), 'the link itself is kept');
  });
});

// --- Q3: dies halfway ---
test('CMP Q3 killed between the .bak rename and the target rename: target untouched, .bak right, rerun heals', (d) => {
  const cfg = path.join(d, 'live.toml'), out = path.join(d, 'out.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(out, 'original\n');
  const r = run(['extract', '--config', cfg, '-o', out], { LINK_REVIEW_KILL_RENAME: '2' }, ['-r', KILL]);
  assert.strictEqual(r.signal, 'SIGKILL', `expected a kill, got exit ${r.code}`);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'original\n');
  assert.strictEqual(fs.readFileSync(out + '.bak', 'utf8'), 'original\n');
  const left = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
  assert.strictEqual(left.length, 1, `temp files left: ${left}`); // the README names this
  const r2 = run(['extract', '--config', cfg, '-o', out]);
  assert.strictEqual(r2.code, 0, r2.err);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), LIVE);
  assert.strictEqual(fs.readFileSync(out + '.bak', 'utf8'), 'original\n');
});
test('CMP Q3b killed before the .bak rename: nothing of the user\'s changed', (d) => {
  const cfg = path.join(d, 'live.toml'), out = path.join(d, 'out.toml');
  fs.writeFileSync(cfg, LIVE); fs.writeFileSync(out, 'original\n'); fs.writeFileSync(out + '.bak', 'last week\n');
  const r = run(['extract', '--config', cfg, '-o', out], { LINK_REVIEW_KILL_RENAME: '1' }, ['-r', KILL]);
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'original\n');
  assert.strictEqual(fs.readFileSync(out + '.bak', 'utf8'), 'last week\n');
});

// --- Q4: the real system against the walk, over the forms the kernel accepts ---
test('CMP Q4 every form the kernel writes through lands where realpath says', (d) => {
  fs.mkdirSync(path.join(d, 'sub')); fs.mkdirSync(path.join(d, 'realdir'));
  fs.symlinkSync(path.join(d, 'realdir'), path.join(d, 'linkdir'));
  fs.symlinkSync('target.toml', path.join(d, 'filelink'));
  const cfg = path.join(d, 'live.toml'); fs.writeFileSync(cfg, LIVE);
  for (const text of ['target.toml', './target.toml', 'sub/../target.toml', 'linkdir/../target.toml', 'sub//target.toml', 'sub/./target.toml', 'filelink', path.join(d, 'sub', '..', 'target.toml')]) {
    const out = path.join(d, `out-${Math.random().toString(36).slice(2)}.toml`);
    fs.symlinkSync(text, out);
    fs.rmSync(path.join(d, 'target.toml'), { force: true }); fs.rmSync(path.join(d, 'sub', 'target.toml'), { force: true });
    assert.strictEqual(osWrite(out), 'writes', text);
    const want = fs.realpathSync.native(out);
    fs.rmSync(want);
    const r = run(['extract', '--config', cfg, '-o', out]);
    assert.strictEqual(r.code, 0, `${text}: ${r.err}`);
    assert.strictEqual(fs.readFileSync(want, 'utf8'), LIVE, text);
  }
});

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
});
