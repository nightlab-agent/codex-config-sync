// Two supported applies update separate tables; --keep makes the changes compatible.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PRELOAD, MCP_OLD, MCP_NEW, PROFILE_OLD, PROFILE_NEW, LIVE, test, files, run,
  contains, success, noLock, successOrConflict, finish,
} = require('./review-overlap-helpers');

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

finish();
