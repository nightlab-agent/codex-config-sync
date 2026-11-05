// Shared fixtures and sequential runner for the overlap and lock suites.
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
function namespace() {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}
function putLock(cfg, pid, host = os.hostname(), ns = namespace()) {
  fs.writeFileSync(cfg + '.lock', JSON.stringify({ pid, host, namespace: ns }));
}
function successOrConflict(r) {
  if (r.code === 0) return;
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /concurrent|conflict|lock|busy|chang|another/i, 'refusal must explain the conflict');
}

// A real apply pauses before the backup rename; always release it, even on assertion failure.
async function held(d, args, inNamespace = false) {
  const ready = path.join(d, 'ready'), release = path.join(d, 'release');
  const cli = ['-r', LOCK_PRELOAD, BIN, ...args];
  // Node is PID 1 inside unshare and spawns the actual holder above PID 1.
  const command = inNamespace ? 'unshare' : process.execPath;
  let innerPid = 64;
  if (inNamespace) {
    // Use an inner PID absent outside, so an outer live process cannot mask takeover.
    for (; innerPid < 1024; innerPid++) {
      try { process.kill(innerPid, 0); } catch (e) { if (e.code === 'ESRCH') break; }
    }
    assert.ok(innerPid < 1024, 'need an unused outer PID for the namespace regression');
  }
  const argv = inNamespace ? ['-Urpf', '--mount-proc', process.execPath, '-e',
    'const cp = require("child_process"); for (let n=2; n<Number(process.env.LOCK_INNER_PID); n++) { if (cp.spawnSync("true").status !== 0) throw new Error("PID setup failed"); } const c = cp.spawn(process.execPath, process.argv.slice(1), {stdio:"inherit"}); c.on("exit", n => {process.exitCode = n;});', '--', ...cli] : cli;
  const c = spawn(command, argv, { timeout: 15000, env: { ...process.env,
    LOCK_CONFIG: args[3], LOCK_STAGE: 'hold-backup', LOCK_READY: ready, LOCK_RELEASE: release, LOCK_INNER_PID: String(innerPid) } });
  let out = '', err = '', ended = false;
  c.stdout.on('data', b => { out += b; });
  c.stderr.on('data', b => { err += b; });
  const done = new Promise((resolve, reject) => {
    c.on('error', reject);
    c.on('close', (code, signal) => { ended = true; resolve({ code, signal, out, err }); });
  });
  const end = Date.now() + 7000;
  while (!fs.existsSync(ready)) {
    if (ended || Date.now() > end) {
      fs.writeFileSync(release, 'release');
      await done;
      throw new Error(`holder did not reach barrier: ${err}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return () => { fs.writeFileSync(release, 'release'); return done; };
}
function finish() {
  chain.then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  });
}

module.exports = {
  BIN, PRELOAD, LOCK_PRELOAD, ROOT, TRUST, MCP_OLD, MCP_NEW, PROFILE_OLD, PROFILE_NEW, LIVE,
  test, files, run, contains, success, remedy, noLock, deadPid, namespace, putLock,
  successOrConflict, held, finish,
};
