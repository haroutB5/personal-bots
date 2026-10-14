// Test classifier: reads a sequence of idle/busy answers from $HBOTS_TEST_FLAGS/idle-seq.txt (default: always idle).
import fs from 'node:fs';
const dir = process.env.HBOTS_TEST_FLAGS;
const seqFile = dir + '/idle-seq.txt';
const posFile = dir + '/idle-pos.txt';
let seq = ['idle'];
if (fs.existsSync(seqFile)) seq = fs.readFileSync(seqFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
let pos = 0;
if (fs.existsSync(posFile)) pos = Number(fs.readFileSync(posFile, 'utf8')) || 0;
const out = seq[Math.min(pos, seq.length - 1)];
fs.writeFileSync(posFile, String(pos + 1));
fs.appendFileSync(dir + '/calls.log', 'idle-look ' + out + '\n');
console.log(out === 'idle' ? 'idle' : 'busy sessions=1 attempts=0 tasks=0 parked=0 resumes=0');
