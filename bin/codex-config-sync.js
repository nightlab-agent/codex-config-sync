#!/usr/bin/env node
// codex-config-sync: share one Codex config.toml across machines while each machine keeps
// its own [projects.*] trust tables. No dependencies. The file is split line by line into
// root statements and tables; values are never parsed or rewritten, only moved whole.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

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

class SplitError extends Error {}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const HEX_DIGITS = { u: 4, U: 8, x: 2 };

// The text of a basic-string key. An escape it cannot read is refused: a key whose name is
// unknown cannot be sorted into shared or machine-local.
function unescapeKey(raw, lineNo) {
  return raw.replace(/\\(?:([uUx])([0-9A-Fa-f]*)|([^]?))/g, (all, kind, hex, one) => {
    if (kind) {
      const n = HEX_DIGITS[kind];
      const code = parseInt(hex.slice(0, n), 16);
      if (hex.length < n || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new SplitError(`line ${lineNo}: cannot read the escape ${all} in a key`);
      return String.fromCodePoint(code) + hex.slice(n);
    }
    if (!(one in ESCAPES)) throw new SplitError(`line ${lineNo}: cannot read the escape ${all} in a key`);
    return ESCAPES[one];
  });
}

// Reads one TOML key path (dotted, bare or quoted) from s at i. Returns { keys, end }.
function readKeyPath(s, i, lineNo) {
  const keys = [];
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    let key;
    if (s[i] === '"') {
      let j = i + 1, out = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') { out += s.slice(j, j + 2); j += 2; } else out += s[j++];
      }
      if (j >= s.length) throw new SplitError(`line ${lineNo}: unterminated quoted key`);
      key = unescapeKey(out, lineNo);
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new SplitError(`line ${lineNo}: unterminated quoted key`);
      key = s.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) throw new SplitError(`line ${lineNo}: cannot read a key`);
      key = m[0];
      i += key.length;
    }
    keys.push(key);
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '.') return { keys, end: i };
    i++;
  }
}

// Walks a value line by line, tracking strings and brackets, so a "[" inside a string or an
// array is never taken for a table header. state: { str: null|'"'|"'"|'"""'|"'''", depth }.
function scanLine(line, state, lineNo) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (state.str === '"""' || state.str === "'''") {
      if (state.str === '"""' && c === '\\') { i += 2; continue; }
      if (line.startsWith(state.str, i)) {
        i += 3;
        while (line[i] === state.str[0]) i++; // up to two quotes may sit before the closing three
        state.str = null;
        continue;
      }
      i++;
      continue;
    }
    if (state.str === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') state.str = null;
      i++;
      continue;
    }
    if (state.str === "'") {
      if (c === "'") state.str = null;
      i++;
      continue;
    }
    if (c === '#') break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { state.str = line.slice(i, i + 3); i += 3; continue; }
    if (c === '"' || c === "'") { state.str = c; i++; continue; }
    if (c === '[' || c === '{') state.depth++;
    else if (c === ']' || c === '}') state.depth--;
    i++;
  }
  if (state.str === '"' || state.str === "'") throw new SplitError(`line ${lineNo}: string not closed on its line`);
  if (state.depth < 0) throw new SplitError(`line ${lineNo}: closing bracket without an opening one`);
}

// Splits TOML text into { eol, root: [stmt], tables: [table] }.
// stmt: { keys, lines }; a blank or comment-only line is a stmt with keys null.
// table: { keys, array, lines }, with the comment lines directly above its header.
function split(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const root = [];
  const tables = [];
  let cur = null; // the table being filled, or null while in the root
  const state = { str: null, depth: 0 };
  let stmt = null; // a statement still open (multi-line value)
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const lineNo = n + 1;
    const t = line.trim();
    if (stmt) {
      if (cur) cur.tail = 0;
      stmt.lines.push(line);
      scanLine(line, state, lineNo);
      if (!state.str && state.depth === 0) stmt = null;
      continue;
    }
    if (t.startsWith('[')) {
      const array = t.startsWith('[[');
      const { keys, end } = readKeyPath(t, array ? 2 : 1, lineNo);
      const close = array ? ']]' : ']';
      if (!t.startsWith(close, end) || !/^\s*(#.*)?$/.test(t.slice(end + close.length))) {
        throw new SplitError(`line ${lineNo}: cannot read the table header`);
      }
      const holder = cur ? cur.lines : null;
      const above = [];
      if (holder) {
        // only comment lines of their own, never the end of a multi-line value that starts with "#"
        for (let k = 0; k < cur.tail; k++) above.unshift(holder.pop());
      } else {
        while (root.length && root[root.length - 1].keys === null && root[root.length - 1].lines[0].trim().startsWith('#')) {
          above.unshift(root.pop().lines[0]);
        }
      }
      cur = { keys, array, lines: [...above, line], tail: 0 };
      tables.push(cur);
      continue;
    }
    if (t === '' || t.startsWith('#')) {
      if (cur) { cur.lines.push(line); cur.tail = t === '' ? 0 : cur.tail + 1; } else root.push({ keys: null, lines: [line] });
      continue;
    }
    const { keys, end } = readKeyPath(t, 0, lineNo);
    if (t[end] !== '=') throw new SplitError(`line ${lineNo}: expected "key = value"`);
    if (cur) { cur.lines.push(line); cur.tail = 0; }
    const s = { keys, lines: [line] };
    if (!cur) root.push(s);
    scanLine(t.slice(end + 1), state, lineNo);
    if (state.str || state.depth > 0) {
      stmt = cur ? { lines: { push: (l) => cur.lines.push(l) } } : s;
    }
  }
  if (stmt || state.str) throw new SplitError('the file ends inside a value');
  return { eol, root, tables };
}

const isLocal = (keys, keep) => keys !== null && keep.includes(keys[0]);

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && out[0].trim() === '') out.shift();
  return out;
}

// The shareable lines and the local blocks of a parsed file.
function partition(doc, keep) {
  const sharedRoot = [], localRoot = [], sharedTables = [], localTables = [];
  const localStmts = doc.root.filter((s) => isLocal(s.keys, keep));
  for (const s of doc.root) (isLocal(s.keys, keep) ? localRoot : sharedRoot).push(...s.lines);
  for (const tb of doc.tables) (isLocal(tb.keys, keep) ? localTables : sharedTables).push(tb);
  return { sharedRoot, localRoot, sharedTables, localTables, localStmts };
}

function shareable(doc, keep) {
  const p = partition(doc, keep);
  const out = trimBlank(p.sharedRoot);
  for (const tb of p.sharedTables) {
    const body = trimBlank(tb.lines);
    if (out.length) out.push('');
    out.push(...body);
  }
  return out;
}

function headerId(tb) { return (tb.array ? '[[' : '[') + JSON.stringify(tb.keys); }
const isUnder = (keys, parent) => parent.every((k, i) => keys[i] === k);

// The merged file: the shared root, the live file's local root statements, the shared
// tables, then the live file's local tables.
function merge(sharedDoc, liveDoc, keep) {
  const s = partition(sharedDoc, keep);
  const l = partition(liveDoc, keep);
  const out = trimBlank(s.sharedRoot);
  if (l.localRoot.length) out.push(...trimBlank(l.localRoot));
  const tables = [...s.sharedTables, ...l.localTables];
  const seen = new Map();
  for (const st of [...sharedDoc.root, ...l.localStmts]) {
    if (!st.keys || (isLocal(st.keys, keep) && !l.localStmts.includes(st))) continue;
    for (let n = 1; n < st.keys.length; n++) {
      const parent = st.keys.slice(0, n);
      seen.set(headerId({ keys: parent }), parent);
    }
  }
  for (const tb of tables) {
    if (tb.array) {
      // a new array element starts its child tables afresh
      for (const [id, keys] of seen) if (isUnder(keys, tb.keys)) seen.delete(id);
    } else {
      const id = headerId(tb);
      if (seen.has(id)) throw new SplitError(`the merged file would define [${tb.keys.join('.')}] twice`);
      seen.set(id, tb.keys);
    }
    if (out.length) out.push('');
    out.push(...trimBlank(tb.lines));
  }
  return { lines: out, ignored: s.localStmts.length + s.localTables.length, kept: l.localStmts.length + l.localTables.length };
}

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
    at = part === '..' ? path.dirname(at) : real(path.join(at, part));
  }
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
      const backedUp = writeOutput(args.out, text);
      console.error(`wrote ${args.out}${backedUp ? `; the old file is ${linkTarget(args.out)}.bak` : ''}`);
    } else process.stdout.write(text);
    return 0;
  }
  if (cmd !== 'apply' && cmd !== 'check') throw new SplitError(`unknown command ${cmd}`);
  if (!shared) throw new SplitError(`${cmd} needs the shared file`);
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
    fs.mkdirSync(path.dirname(config), { recursive: true });
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
}

module.exports = { split, shareable, merge, SplitError };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof SplitError || e.code) { console.error(`codex-config-sync: ${e.message}`); process.exitCode = 2; } else throw e;
  }
}
