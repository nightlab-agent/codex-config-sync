// Release review: filesystem resolution must agree with the operating system.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = process.env.REVIEW_BIN || path.join(__dirname, '..', 'bin', 'codex-config-sync.js');
let passed = 0, failed = 0;

function test(name, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-release-review-'));
  try { fn(d); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}

function extractThroughLink(d, aliasParent) {
  const real = path.join(d, 'real');
  const sub = path.join(real, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const target = path.join(real, 'target.toml');
  const unrelated = path.join(d, 'target.toml');
  fs.writeFileSync(target, 'intended old\n');
  fs.writeFileSync(unrelated, 'unrelated notes\n');
  fs.symlinkSync('../target.toml', path.join(sub, 'output.toml'));
  let parent = sub;
  if (aliasParent) {
    parent = path.join(d, 'alias');
    fs.symlinkSync(sub, parent);
  }
  const out = path.join(parent, 'output.toml');
  assert.strictEqual(fs.realpathSync(out), target, 'the OS must resolve the intended target');
  const cfg = path.join(d, 'live.toml');
  const text = 'model = "new"\n';
  fs.writeFileSync(cfg, text);
  const r = spawnSync(process.execPath, [BIN, 'extract', '--config', cfg, '-o', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'unrelated notes\n', 'extract overwrote an unrelated file instead of the symlink target');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), text, 'extract did not update the symlink target');
  assert.ok(fs.lstatSync(out).isSymbolicLink(), 'extract must keep the link');
}

test('CMP relative output link beneath a symlinked directory follows the OS target', (d) => extractThroughLink(d, true));
test('CMP relative output link beneath a plain directory follows the OS target', (d) => extractThroughLink(d, false));

test('BUG a link whose text goes through a link and then .. follows the OS target', (d) => {
  const deep = path.join(d, 'real', 'sub');
  fs.mkdirSync(deep, { recursive: true });
  const target = path.join(d, 'real', 'target.toml');
  fs.writeFileSync(target, 'intended old\n');
  fs.writeFileSync(path.join(d, 'target.toml'), 'unrelated notes\n');
  fs.symlinkSync(deep, path.join(d, 'alias'));
  fs.symlinkSync('alias/../target.toml', path.join(d, 'out.toml'));
  assert.strictEqual(fs.realpathSync.native(path.join(d, 'out.toml')), target, 'the OS must resolve the intended target');
  const cfg = path.join(d, 'live.toml');
  fs.writeFileSync(cfg, 'model = "new"\n');
  const r = spawnSync(process.execPath, [BIN, 'extract', '--config', cfg, '-o', path.join(d, 'out.toml')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(d, 'target.toml'), 'utf8'), 'unrelated notes\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'model = "new"\n');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
