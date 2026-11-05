// Kills the process at the Nth rename, as a crash between the .bak rename and the target rename would.
'use strict';
const fs = require('fs');
const stopAt = Number(process.env.LINK_REVIEW_KILL_RENAME || '2');
const orig = fs.renameSync;
let n = 0;
fs.renameSync = function (...args) {
  if (++n === stopAt) process.kill(process.pid, 'SIGKILL');
  return orig.apply(this, args);
};
