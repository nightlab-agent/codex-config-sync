#!/usr/bin/env node
// codex-config-sync: share one Codex config.toml across machines while each machine keeps
// its own [projects.*] trust tables. No dependencies. The file is split line by line into
// root statements and tables; values are never parsed or rewritten, only moved whole.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const USAGE = `codex-config-sync: share ~/.codex/config.toml across machines; each machine keeps its trust tables.

Usage:
  codex-config-sync extract [-o FILE]       print the live config without machine-local tables
  codex-config-sync apply SHARED [--dry-run] write SHARED into the live config, keeping its local tables
  codex-config-sync check SHARED            exit 1 if the live config's shared part differs from SHARED

Options:
  --config PATH   the live config (default: $CODEX_HOME/config.toml, else ~/.codex/config.toml)
  --keep KEY      a top-level key that stays per machine; repeat for more (default: projects)
  -o, --out FILE  extract writes FILE instead of printing
  --dry-run       apply prints the result and writes nothing`;

const { split, shareable, merge, SplitError } = require('./toml-lines');

function modeOf(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; }
}

// Follows a chain of links, dangling ones too, to the file a write should land on.
function linkTarget(file) {
  for (let n = 0; n < 40; n++) {
    let to;
    try { to = fs.readlinkSync(file); } catch { return file; }
    file = walkLink(path.dirname(file), to);
  }
  throw new SplitError(`${file}: too many links`);
}

// The path a link's text names, step by step as the system walks it: `..` after a linked folder
// leaves that folder's real parent, which path.resolve would get wrong.
function walkLink(dir, to) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  let at = path.isAbsolute(to) ? path.parse(to).root : real(dir);
  for (const part of to.split(path.sep)) {
    if (!part || part === '.') continue;
    if (!fs.statSync(at, { throwIfNoEntry: false })?.isDirectory()) throw new SplitError(`${to}: ${at} is not a folder`);
    at = part === '..' ? path.dirname(at) : real(path.join(at, part));
  }
  if (/(^|\/)\.?$/.test(to)) throw new SplitError(`${to}: a link ending in a slash names a folder, not a file`);
  return at;
}

// Writes by rename, so a link at `file` is replaced, never followed, and the file has exactly
// `mode`. `stillSafe`, when given, runs last: false leaves `file` alone and returns false.
function replaceFile(file, text, mode, stillSafe) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
  fs.chmodSync(tmp, mode); // the umask has cut the mode the write asked for
  if (stillSafe && !stillSafe()) { fs.rmSync(tmp, { force: true }); return false; }
  fs.renameSync(tmp, file);
  return true;
}

// True when the two names reach one file, through links or not.
function sameFile(a, b) {
  const [x, y] = [a, b].map((f) => fs.statSync(f, { throwIfNoEntry: false }));
  return !!x && !!y && x.dev === y.dev && x.ino === y.ino;
}

// extract's output: a link is written where it points, and an old file is kept as FILE.bak.
function writeOutput(file, text) {
  const target = linkTarget(file);
  const mode = modeOf(target);
  let old = null;
  try { old = fs.readFileSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== null) replaceFile(target + '.bak', old, mode);
  replaceFile(target, text, mode);
  return old !== null;
}

function readDoc(file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try { return { ...split(text.replace(/^﻿/, '')), text }; } catch (e) {
    if (e instanceof SplitError) throw new SplitError(`${what} ${file}: ${e.message}`);
    throw e;
  }
}

function defaultConfig() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function deadPid(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'ESRCH'; }
  return false; // EPERM and a reused but live pid are never grounds for takeover.
}

function claimPrefix(lock) { return `${lock}.reap-${Buffer.from(os.hostname()).toString('hex')}-`; }

// Recovery links have unique names and identify the recovering process's host and pid,
// even if it died after removing the lock. A live or reused pid leaves its link alone.
function cleanClaims(lock) {
  const prefix = path.basename(claimPrefix(lock));
  for (const name of fs.readdirSync(path.dirname(lock))) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name.slice(prefix.length));
    if (!match || !deadPid(Number(match[1]))) continue;
    const file = path.join(path.dirname(lock), name);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// Keep the old inode open throughout recovery. A private hard link selects one process:
// only the original name plus our link (nlink == 2) permits unlinking the original.
// A rival keeps its link until its check finishes, so it cannot also pass that check.
function recoverLock(lock) {
  let fd;
  try { fd = fs.openSync(lock, 'r'); } catch (e) { if (e.code === 'ENOENT') return 'holder changed'; throw e; }
  try {
    const old = fs.fstatSync(fd);
    if (!old.isFile()) return 'unknown holder (not a regular lock file)';
    let owner;
    try { owner = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch (e) {
      if (e instanceof SyntaxError) return 'unknown holder (incomplete lock record)';
      throw e;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== 'string') return 'unknown holder (invalid lock record)';
    const holder = `pid ${owner.pid} on ${owner.host}`;
    if (owner.host !== os.hostname() || !deadPid(owner.pid)) return holder;
    const isOld = (s) => s && s.dev === old.dev && s.ino === old.ino;
    cleanClaims(lock);
    const claim = `${claimPrefix(lock)}${process.pid}-${randomUUID()}`;
    try { fs.linkSync(lock, claim); } catch (e) { if (e.code === 'ENOENT') return holder; throw e; }
    try {
      const now = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (isOld(now) && isOld(fs.lstatSync(claim)) && now.nlink === 2) fs.unlinkSync(lock);
    } finally { fs.unlinkSync(claim); }
    return holder;
  } catch (e) {
    // drvfs can lose even an open descriptor when the holder removes the lock.
    if (e.code === 'ENOENT') return 'holder changed';
    throw e;
  } finally { fs.closeSync(fd); }
}

function lockRemedy(lock) {
  return `Check that no apply is still running on any host using this config. Only then remove ${lock} and run apply again.`;
}

function lockConfig(config) {
  const lock = config + '.lock';
  try {
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let holder;
    for (let n = 0; n <= 10; n++) {
      let fd;
      try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (fd !== undefined) {
        try {
          try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }) + '\n'); }
          finally { fs.closeSync(fd); }
          cleanClaims(lock);
        } catch (e) { fs.unlinkSync(lock); throw e; }
        return () => fs.unlinkSync(lock);
      }
      holder = recoverLock(lock);
      if (n < 10) Atomics.wait(pause, 0, 0, 50);
    }
    throw new SplitError(`${lock}: lock busy after waiting 500 ms; holder: ${holder}; nothing written. ${lockRemedy(lock)}`);
  } catch (e) {
    if (e instanceof SplitError) throw e;
    throw new SplitError(`${lock}: ${e.message}. Check folder permissions and filesystem support for exclusive create and hard links. If the lock remains: ${lockRemedy(lock)}`);
  }
}

function main(argv) {
  const args = { keep: [], pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new SplitError(`${a} needs a value`); return argv[++i]; };
    if (a === '--config') args.config = val();
    else if (a === '--keep') args.keep.push(val());
    else if (a === '-o' || a === '--out') args.out = val();
    else if (a === '--dry-run') args.dry = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); return 0; }
    else if (a === '-v' || a === '--version') { console.log(require('../package.json').version); return 0; }
    else if (a.startsWith('-')) throw new SplitError(`unknown option ${a}`);
    else args.pos.push(a);
  }
  const keep = args.keep.length ? args.keep : ['projects'];
  const [cmd, shared] = args.pos;
  const config = args.config || defaultConfig();
  if (!cmd) { console.log(USAGE); return 2; }

  if (cmd === 'extract') {
    const live = readDoc(config, 'live config');
    if (!live) throw new SplitError(`no live config at ${config}`);
    const text = shareable(live, keep).join(live.eol) + live.eol;
    if (args.out) {
      if (sameFile(args.out, config)) throw new SplitError(`${args.out} is the live config: extract would replace it and drop its machine-local entries. Name another file.`);
      if (sameFile(linkTarget(args.out) + '.bak', config)) throw new SplitError(`${args.out}.bak is the live config: extract keeps the old output there and would replace it. Name another file.`);
      const backedUp = writeOutput(args.out, text);
      console.error(`wrote ${args.out}${backedUp ? `; the old file is ${linkTarget(args.out)}.bak` : ''}`);
    } else process.stdout.write(text);
    return 0;
  }
  if (cmd !== 'apply' && cmd !== 'check') throw new SplitError(`unknown command ${cmd}`);
  if (!shared) throw new SplitError(`${cmd} needs the shared file`);
  // Refuse a missing shared file before creating the config folder or lock; contents
  // are still read under the lock, since the shared file may be the live config.
  if (!fs.statSync(shared, { throwIfNoEntry: false })) throw new SplitError(`no shared file at ${shared}`);
  if (cmd === 'apply' && !args.dry && !fs.statSync(path.dirname(config), { throwIfNoEntry: false })) {
    // With no config folder, validate against an empty live file before creating anything.
    // Re-read under the lock below: another apply may create the folder and config meanwhile.
    const doc = readDoc(shared, 'shared file');
    if (!doc) throw new SplitError(`no shared file at ${shared}`);
    split(merge(doc, split(''), keep).lines.join(doc.eol) + doc.eol);
  }
  const unlock = cmd === 'apply' && !args.dry ? lockConfig(config) : () => {};
  try {
    const sharedDoc = readDoc(shared, 'shared file');
    if (!sharedDoc) throw new SplitError(`no shared file at ${shared}`);
    const liveDoc = readDoc(config, 'live config') || split('');

    if (cmd === 'check') {
      const a = shareable(sharedDoc, keep);
      const b = shareable(liveDoc, keep);
      if (a.join('\n') === b.join('\n')) { console.log('in sync'); return 0; }
      const sa = new Set(a), sb = new Set(b);
      for (const x of b) if (!sa.has(x)) console.log(`- ${x}   (live only)`);
      for (const x of a) if (!sb.has(x)) console.log(`+ ${x}   (shared only)`);
      if ([...a].every((x) => sb.has(x)) && [...b].every((x) => sa.has(x))) console.log('(same lines, different order)');
      return 1;
    }

    let isLink = false;
    try { isLink = fs.lstatSync(config).isSymbolicLink(); } catch {}
    if (isLink && !args.dry) {
      throw new SplitError(`${config} is a symlink, which apply does not write through. Replace the link with a plain file, then run apply.`);
    }
    // Codex may save a trust choice while this runs: merge from one read, and start again if the
    // file changed before the rename (three tries).
    let live = liveDoc;
    for (let attempt = 1; ; attempt++) {
      const eol = live.text !== undefined ? live.eol : sharedDoc.eol;
      const m = merge(sharedDoc, live, keep);
      const text = m.lines.join(eol) + eol;
      split(text); // the result must split cleanly too
      if (attempt === 1 && m.ignored) console.error(`ignored ${m.ignored} machine-local entr${m.ignored === 1 ? 'y' : 'ies'} in ${shared}`);
      if (args.dry) { process.stdout.write(text); return 0; }
      const before = live.text === undefined ? null : live.text;
      const kept = `${m.kept} local entr${m.kept === 1 ? 'y' : 'ies'} kept`;
      if (before === text) { console.log(`already in sync (${kept})`); return 0; }
      const unchanged = () => {
        let now = null;
        try { now = fs.readFileSync(config, 'utf8'); } catch {}
        return now === before;
      };
      const again = () => {
        if (attempt === 3) throw new SplitError(`${config} kept changing while apply ran; nothing written, run apply again`);
        live = readDoc(config, 'live config') || split('');
      };
      if (!unchanged()) { again(); continue; }
      const mode = modeOf(config);
      // The backup goes last of all: a refused try must leave the last good one.
      const safe = () => {
        if (!unchanged()) return false;
        if (before !== null) replaceFile(config + '.bak', before, mode);
        return true;
      };
      if (!replaceFile(config, text, mode, safe)) { again(); continue; }
      console.log(`wrote ${config} (${kept}${before !== null ? `; the old file is ${config}.bak` : ''})`);
      return 0;
    }
  } finally { unlock(); }
}

module.exports = { split, shareable, merge, SplitError };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof SplitError || e.code) { console.error(`codex-config-sync: ${e.message}`); process.exitCode = 2; } else throw e;
  }
}
