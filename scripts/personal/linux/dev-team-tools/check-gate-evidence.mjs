#!/usr/bin/env node
import fs from 'node:fs';
import {options,validate} from './gate-common.mjs';
let v;
try {v=options()} catch(e){console.error(e.message);process.exit(2)}
try {
  const errors=validate(JSON.parse(fs.readFileSync(v.file,'utf8')),v);
  if(errors.length) throw new Error(errors.join('\n'));
  console.log(`PASS: ${v.release} (${v.version}) gate evidence verified`);
} catch(e){console.error(`FAIL: ${e.message}`);process.exit(1)}
