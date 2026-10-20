// Bounded, synthetic RAM pressure. Parent owns this worker and always terminates
// it. No database access, no disk writes, at most 4 GiB for at most 3 minutes.
import os from "node:os";
import { parentPort } from "node:worker_threads";
const blocks = [];
let cursor = 0;
const started = Date.now();
let announced = false;
const timer = setInterval(() => {
  const free = os.freemem() / 1024 ** 2;
  if (Date.now() - started > 180_000) {
    clearInterval(timer);
    parentPort.close();
    return;
  }
  if (free > 450 && blocks.length < 128) {
    // Commit each page, rather than reserve untouched virtual address space.
    const block = Buffer.allocUnsafe(32 * 1024 ** 2);
    block.fill(1);
    blocks.push(block);
  }
  if (blocks.length) {
    const block = blocks[cursor++ % blocks.length];
    for (let i = 0; i < block.length; i += 4096) block[i] ^= 1;
  }
  if (!announced && (free <= 500 || blocks.length === 128 || Date.now() - started > 30_000)) {
    announced = true;
    parentPort.postMessage({ freeMb: free, heldMb: blocks.length * 32 });
  }
}, 50);
