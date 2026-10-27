import test from 'node:test';
import assert from 'node:assert/strict';
import { busyReasons, classifyOrphan, dueWaitingAlerts, hasSessionAncestor, sendWaitingAlerts, waitingSummary } from '../lib/idle.mjs';
import { cgroupPathFromProcText, onlyInCgroup } from '../lib/proc.mjs';

test('busy tools are only the server cgroup, never a sibling systemd scope', () => {
  // A computer-use Chromium is still a process-tree descendant of the server,
  // but systemd moved it into app-org.chromium.Chromium-*.scope.
  const tree = [700, 701, 702];
  const members = new Map([
    [700, '/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service'],
    [701, '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-123.scope'],
    [702, '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-123.scope'],
  ]);
  const server = '/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service';
  assert.deepEqual([...onlyInCgroup(tree, members, server)], [700]);
  // Unreadable membership is never guessed into the server's work.
  assert.deepEqual([...onlyInCgroup(tree, new Map(), server)], []);
  // With no server cgroup to compare against, keep the tree (old behaviour).
  assert.deepEqual([...onlyInCgroup(tree, members, null)], tree);
  assert.equal(
    cgroupPathFromProcText('0::/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service\n'),
    '/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service',
  );
  assert.equal(cgroupPathFromProcText(''), null);
});

test('orphan is reported and only ignored after ten minutes; pid reuse and a bot turn remain blocking', () => {
  const seen = new Map();
  const proc = { pid: 123, ppid: 900, startTicks: 33 };
  const systemd = { cmdline: '/usr/lib/systemd/systemd --user' };
  const age = 31 * 60_000;
  assert.deepEqual(classifyOrphan(proc, systemd, age, 0, seen), { orphan: true, ignored: false });
  assert.equal(classifyOrphan(proc, systemd, age, 599_999, seen).ignored, false);
  assert.equal(classifyOrphan(proc, systemd, age, 600_000, seen).ignored, true);
  const orphanLook = { toolProcs: [{ pid: 123, cmd: 'opencode serve --service', ageSec: 1860, orphan: true, ignored: false }], cpu: 0, eventsAgeMs: 999999, heavy: { held: false } };
  const cfg = { cpuBudgetS: 1, eventsQuietMs: 1000 };
  assert.match(busyReasons(orphanLook, cfg)[0], /pid=123.*orphan-tool/);
  orphanLook.toolProcs[0].ignored = true;
  assert.deepEqual(busyReasons(orphanLook, cfg), []);
  assert.equal(classifyOrphan({ ...proc, startTicks: 34 }, systemd, age, 600_000, seen).ignored, false);
  const turn = { pid: 124, ppid: 125, startTicks: 5 };
  assert.equal(classifyOrphan(turn, { cmdline: 'opencode acp' }, age, 2_000_000, seen).orphan, false);
  assert.equal(hasSessionAncestor(turn, new Map([[125, { ppid: 1, cmdline: 'opencode acp' }]])), true);
  const look = { toolProcs: [{ pid: 124, cmd: 'node task', ageSec: 2000, ignored: false }], cpu: 0, eventsAgeMs: 999999, heavy: { held: false } };
  assert.match(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 })[0], /pid=124/);
  look.toolProcs[0].ignored = true;
  assert.deepEqual(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 }), []);
  look.eventsAgeMs = 1;
  assert.match(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 })[0], /events/);
});

test('waiting alerts are due once at 20 and once at 60 minutes', () => {
  const sent = new Set();
  assert.deepEqual(dueWaitingAlerts(1_199_999, sent), []);
  assert.deepEqual(dueWaitingAlerts(1_200_000, sent), [20]);
  sent.add(20);
  assert.deepEqual(dueWaitingAlerts(3_599_999, sent), []);
  assert.deepEqual(dueWaitingAlerts(3_600_000, sent), [60]);
  sent.add(60);
  assert.deepEqual(dueWaitingAlerts(9_000_000, sent), []);
});

test('waiting notifications include blockers and are sent once at each threshold', () => {
  const seen = new Set();
  const sent = [];
  const notices = [];
  const send = (text) => { sent.push(text); return 0; };
  const deliver = (alert) => { notices.push(alert); return `/tmp/${alert.minutes}.json`; };
  for (const t of [1_199_999, 1_200_000, 1_300_000, 3_600_000, 3_700_000])
    sendWaitingAlerts({ elapsedMs: t, alerted: seen, version: '9.9.9', summary: 'node pid 123, 245s', send, deliver });
  assert.equal(sent.length, 2);
  assert.equal(sent[0], 'hbots 9.9.9 release is waiting (20 min): node pid 123, 245s');
  assert.deepEqual(notices.map((n) => [n.minutes, n.text]), [
    [20, 'hbots release 9.9.9 waiting on: node pid 123, 245s'],
    [60, 'hbots release 9.9.9 waiting on: node pid 123, 245s'],
  ]);
});

test('a failed desktop toast is recorded but the chat notice is still delivered', () => {
  const seen = new Set();
  const delivered = [];
  const [alert] = sendWaitingAlerts({
    elapsedMs: 0,
    minutes: [0],
    alerted: seen,
    version: '9.9.9',
    summary: 'sleep pid 5, 30s',
    send: () => ({ exit: 127, error: 'notify-send: not found' }),
    deliver: (a) => { delivered.push(a); return '/tmp/notice.json'; },
  });
  assert.equal(alert.exit, 127);
  assert.equal(alert.error, 'notify-send: not found');
  assert.equal(alert.noticeFile, '/tmp/notice.json');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].minutes, 0);
  assert.equal(seen.has(0), true);
});

test('waiting summary names one blocker briefly and keeps the full list', () => {
  const { short, full } = waitingSummary([
    { pid: 12, cmd: '/usr/lib/chromium/chromium --type=gpu-process', ageSec: 300, ignored: false },
    { pid: 13, cmd: 'python3 watch.py', ageSec: 20, ignored: false },
    { pid: 14, cmd: 'old thing', ageSec: 900, ignored: true },
  ]);
  assert.equal(short, '2 blockers, e.g. chromium pid 12, 300s');
  assert.match(full, /\/usr\/lib\/chromium\/chromium --type=gpu-process pid 12, 300s; python3 watch\.py pid 13, 20s/);
  assert.doesNotMatch(full, /old thing/);
});

test('desk panel displays the current waiting blocker', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbots-panel-fixture-'));
  fs.mkdirSync(path.join(root, 'run'));
  fs.writeFileSync(path.join(root, 'run/restart-9.9.9-result.json'), JSON.stringify({ status: 'waiting_for_idle', version: '9.9.9', blockers: [{ pid: 123, cmd: '/usr/bin/node task', ageSec: 245, ignored: false }] }));
  const result = spawnSync('bash', [new URL('../hbots-desk-status', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, HBOTS_STATUS_ROOT: root, HBOTS_STATUS_ONCE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /waiting on: node pid 123, 245s/);
});

test('desk panel shows both running heavy jobs and the 5-bot cap', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn, spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbots-panel-heavy-'));
  fs.mkdirSync(path.join(root, 'run'));
  for (const [slot, label] of [[1, 'frontend build'], [2, 'qa e2e']]) {
    fs.writeFileSync(path.join(root, `run/omarchy-heavy-${slot}.lock`), `pid=${slot} started=${new Date().toISOString()} label=${label} cwd=/x slot=${slot}.lock\n`);
  }
  const holders = [1, 2].map((slot) => spawn('flock', ['-x', path.join(root, `run/omarchy-heavy-${slot}.lock`), 'sleep', '8'], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 400));
  try {
    const result = spawnSync('bash', [new URL('../hbots-desk-status', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, HBOTS_STATUS_ROOT: root, HBOTS_STATUS_ONCE: '1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /limit 5 \(build\)/);
    assert.match(result.stdout, /frontend build/);
    assert.match(result.stdout, /qa e2e/);
    assert.match(result.stdout, /job1/);
    assert.match(result.stdout, /job2/);
  } finally {
    for (const holder of holders) holder.kill('SIGTERM');
  }
});
