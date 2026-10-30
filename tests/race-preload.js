// Simulates Codex writing a trust table between apply's first read of the live config and its second.
const fs = require('fs');
const target = process.env.RACE_CONFIG;
const orig = fs.readFileSync;
let n = 0;
fs.readFileSync = function (p, ...rest) {
  const r = orig.call(this, p, ...rest);
  if (p === target && ++n === 1) fs.appendFileSync(target, '\n[projects."/new/repo"]\ntrust_level = "trusted"\n');
  return r;
};
