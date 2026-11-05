// Simulates a trust save after apply's LAST read (the stillSafe check inside replaceFile), before the rename.
'use strict';
const fs = require('fs');
const target = process.env.TS_REVIEW_CONFIG;
const hit = (process.env.TS_REVIEW_HITS || '3').split(',').map(Number);
const orig = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (file, ...rest) {
  const text = orig.call(this, file, ...rest);
  if (file === target && hit.includes(++reads)) fs.appendFileSync(target, `\n[projects."/new${reads}"]\ntrust_level = "trusted"\n`);
  return text;
};
