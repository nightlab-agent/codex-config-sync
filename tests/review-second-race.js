// Simulates a trust save immediately after apply's final verification read.
'use strict';
const fs = require('fs');
const target = process.env.SECOND_REVIEW_CONFIG;
const orig = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (file, ...rest) {
  const text = orig.call(this, file, ...rest);
  if (file === target && ++reads === 2) {
    fs.appendFileSync(target, '\n[projects."/new"]\ntrust_level = "trusted"\n');
  }
  return text;
};
