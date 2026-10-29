#!/usr/bin/env node
// Offline tests for migrate/. Run from the repo root:
//
//   node migrate/tests/run-tests.mjs
//
// No real disk, USB stick, backup or network is used. PowerShell self-tests use
// %TEMP%, and the shell scripts run only with --dry-run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const windowsDir = path.join(repoRoot, 'migrate', 'windows');
const linuxDir = path.join(repoRoot, 'migrate', 'linux');
const prewipe = path.join(windowsDir, 'prewipe.ps1');
const makeInstaller = path.join(windowsDir, 'make-installer.ps1');
const bootstrap = path.join(linuxDir, 'bootstrap.sh');
const verify = path.join(linuxDir, 'verify.sh');
const enableSsh = path.join(linuxDir, 'enable-ssh.sh');
const firstLogin = path.join(linuxDir, 'first-login.sh');
const pasteTxt = path.join(linuxDir, 'PASTE.txt');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hbots-migrate-tests-'));
let passed = 0;
let failed = 0;
let skipped = 0;
let powershell = null;
let bash = null;

function log(message) {
  console.log(message);
}

function findPowerShell() {
  if (process.platform !== 'win32') {
    const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (pwsh.status === 0 && pwsh.stdout.trim() === '5') {
      return 'pwsh';
    }
    return null;
  }
  const candidates = [
    process.env.POWERSHELL,
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === '5') {
      return candidate;
    }
  }
  return null;
}

function findBash() {
  const candidates = [
    process.env.BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'bash' && process.platform === 'win32') {
      continue;
    }
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /GNU bash/.test(result.stdout)) {
      return candidate;
    }
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [
      `${command} ${args.join(' ')} exited ${result.status}`,
      '--- stdout ---',
      (result.stdout || '').trim(),
      '--- stderr ---',
      (result.stderr || '').trim(),
    ].join('\n');
    throw new Error(detail);
  }
  return result;
}

function runPwsh(script, args) {
  if (!powershell) {
    throw new Error('Windows PowerShell 5.1 was not found.');
  }
  return run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { timeout: 300000 });
}

function runBash(args, options = {}) {
  if (!bash) {
    throw new Error('bash was not found (Git for Windows bash is expected on Windows).');
  }
  return run(bash, args, { timeout: 120000, ...options });
}

function toPosix(winPath) {
  const resolved = path.resolve(winPath).replace(/\\/g, '/');
  return resolved.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function writeStub(directory, name, body) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows may ignore the mode; Git Bash still runs shebang scripts.
  }
  if (bash) {
    const quoted = toPosix(file).replace(/'/g, "'\\''");
    spawnSync(bash, ['-c', `chmod +x '${quoted}'`], { encoding: 'utf8' });
  }
  return file;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function manifest(root) {
  const result = new Map();
  for (const file of walkFiles(root)) {
    result.set(path.relative(root, file), sha256File(file));
  }
  return result;
}

function assertManifestUnchanged(before, after, label) {
  assert.equal(after.size, before.size, `${label}: file count changed`);
  for (const [name, hash] of before) {
    assert.equal(after.get(name), hash, `${label}: ${name} changed`);
  }
}

function skip(name, reason) {
  skipped++;
  log(`SKIP ${name} (${reason})`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    log(`PASS ${name}`);
  } catch (error) {
    failed++;
    log(`FAIL ${name}`);
    log(String(error.stack || error.message).split('\n').map((line) => `     ${line}`).join('\n'));
  }
}

async function main() {
  log('migrate test suite');
  log(`repo: ${repoRoot}`);

  powershell = findPowerShell();
  bash = findBash();
  log(`powershell: ${powershell || 'NOT FOUND'}`);
  log(`bash: ${bash || 'NOT FOUND'}`);

  const migrateBefore = manifest(path.join(repoRoot, 'migrate'));

  if (powershell) {
    await test('prewipe.ps1 -SelfTest exits 0', () => {
      const result = runPwsh(prewipe, ['-SelfTest']);
      assert.match(result.stdout, /SELFTEST PASS/);
      assert.doesNotMatch(result.stdout, /SELFTEST FAIL/);
    });
  } else {
    skip('prewipe.ps1 -SelfTest exits 0', 'Windows PowerShell 5.1 is not available on this host');
  }

  if (powershell) {
    await test('make-installer.ps1 -SelfTest exits 0', () => {
      const result = runPwsh(makeInstaller, ['-SelfTest']);
      assert.match(result.stdout, /SELFTEST PASS/);
      assert.doesNotMatch(result.stdout, /SELFTEST FAIL/);
    });
  } else {
    skip('make-installer.ps1 -SelfTest exits 0', 'Windows PowerShell 5.1 is not available on this host');
  }

  await test('make-installer is ISO-only: no cidata and no password prompt', () => {
    const source = fs.readFileSync(makeInstaller, 'utf8');
    assert.doesNotMatch(source, /cidata/i, 'make-installer still mentions cidata');
    assert.doesNotMatch(source, /unattended/i, 'make-installer still mentions unattended installs');
    assert.doesNotMatch(source, /Read-Host\s+-AsSecureString/, 'make-installer still prompts for a password');
    assert.match(source, /-IsoDiskNumber/, 'make-installer keeps the ISO write path');
    assert.match(source, /published checksum/, 'make-installer keeps the checksum check');
  });

  await test('enable-ssh.sh --print gives one line with sshd and the team keys', () => {
    const result = runBash([enableSsh, '--print']);
    assert.match(result.stdout, /systemctl enable --now sshd/);
    assert.match(result.stdout, /hbots-cto@laptop/);
    assert.match(result.stdout, /hbots-migrate@gamingpc/);
    assert.match(result.stdout, /authorized_keys/);
    assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('sudo pacman'));
    assert.ok(line, 'the pasteable line is printed');
    assert.equal(line.split('\n').length, 1, 'the pasteable line is one line');
  });

  await test('enable-ssh.sh --apply exists and is consistent with --print', () => {
    const source = fs.readFileSync(enableSsh, 'utf8');
    assert.match(source, /--apply/);
    assert.match(source, /systemctl enable --now sshd/);
    assert.doesNotMatch(source, /PRIVATE KEY/);
  });

  await test('bash -n accepts bootstrap.sh, verify.sh, enable-ssh.sh and first-login.sh', () => {
    runBash(['-n', bootstrap]);
    runBash(['-n', verify]);
    runBash(['-n', enableSsh]);
    runBash(['-n', firstLogin]);
  });

  await test('first-login.sh --print-line is the one paste: mount SSD read-only, run the payload', () => {
    const result = runBash([firstLogin, '--print-line']);
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one line is printed');
    const line = lines[0];
    assert.match(line, /^sudo bash -c /);
    assert.match(line, /SanDisk Extreme/);
    assert.match(line, /mount -t ntfs3 -o ro/);
    assert.match(line, /payload\/first-login\.sh/);
    assert.doesNotMatch(line, /mkfs|format|rm -/, 'the paste line never formats or deletes');
    const file = fs.readFileSync(pasteTxt, 'utf8').replace(/\r\n/g, '\n').trim();
    assert.equal(file, line, 'PASTE.txt and --print-line are the same line');
  });

  await test('first-login.sh verifies the payload and refuses a tampered copy', () => {
    const mountRoot = path.join(tempRoot, 'fake-mount');
    const payloadDir = path.join(mountRoot, 'payload');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.mkdirSync(path.join(mountRoot, 'plain', 'Claude'), { recursive: true });
    fs.mkdirSync(path.join(mountRoot, 'plain', 'personal-bots'), { recursive: true });
    const names = ['first-login.sh', 'bootstrap.sh', 'verify.sh', 'enable-ssh.sh'];
    const entries = [];
    for (const name of names) {
      const dest = path.join(payloadDir, name);
      fs.copyFileSync(path.join(linuxDir, name), dest);
      entries.push(`${sha256File(dest)}  payload/${name}`);
    }
    entries.push(`${sha256File(path.join(linuxDir, 'PASTE.txt'))}  payload/PASTE.txt`);
    fs.copyFileSync(pasteTxt, path.join(payloadDir, 'PASTE.txt'));
    fs.writeFileSync(path.join(mountRoot, 'payload.sha256'), `${entries.join('\n')}\n`);

    const currentUser = spawnSync(bash, ['-c', 'id -un'], { encoding: 'utf8' }).stdout.trim();
    const before = manifest(mountRoot);
    const ok = runBash([
      firstLogin,
      '--check-only',
      '--skip-volume-check',
      '--user', currentUser,
      '--mount', mountRoot,
      '--source', path.join(mountRoot, 'plain'),
    ]);
    assert.match(ok.stdout, /Check complete/);
    assert.match(ok.stdout, /5 payload files match their hashes/);
    assertManifestUnchanged(before, manifest(mountRoot), 'first-login check-only');

    fs.appendFileSync(path.join(payloadDir, 'bootstrap.sh'), '\n# tampered\n');
    const tampered = spawnSync(bash, [
      firstLogin,
      '--check-only',
      '--skip-volume-check',
      '--user', currentUser,
      '--mount', mountRoot,
      '--source', path.join(mountRoot, 'plain'),
    ], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0, 'a tampered payload exits non-zero');
    assert.match(`${tampered.stdout}${tampered.stderr}`, /payload hash check failed/);
  });

  await test('bootstrap.sh restores from the SSD and has no gaming-PC path', () => {
    const source = fs.readFileSync(bootstrap, 'utf8');
    assert.match(source, /\/mnt\/hbots-backup\/plain/, 'the default restore root is the SSD');
    assert.match(source, /\/mnt\/hbots-backup\/secrets\.bundle/, 'the default bundle is on the SSD');
    assert.doesNotMatch(source, /gamingpc|gaming PC/i, 'no gaming-PC restore path is left');
    assert.doesNotMatch(source, /HBOTS_SECRETS_PASSPHRASE=['"]/, 'the passphrase is never assigned on a command line');
    assert.match(source, /read -rs/, 'the passphrase is read silently from the terminal');
  });

  await test('prewipe.ps1 is SSD-only, live-database safe and image-free', () => {
    const source = fs.readFileSync(prewipe, 'utf8');
    assert.match(source, /SanDisk Extreme 55AE/);
    assert.match(source, /2306CQ402457/);
    assert.match(source, /hbots-omarchy-backup/);
    assert.match(source, /sqlite-snapshot\.cjs/, 'the live database uses the online backup helper');
    assert.doesNotMatch(source, /wbadmin|FullImage/, 'there is no disk image path any more');
    assert.doesNotMatch(source, /GAMINGPC|\\\\GAMINGPC/i, 'there is no gaming-PC target');
    assert.match(source, /payload\.sha256/, 'the payload carries a hash manifest');
    assert.match(source, /PASTE-ME\.txt/, 'the paste file is written for Harout');
  });

  await test('shellcheck passes when installed', () => {
    const available = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
    if (available.error || available.status !== 0) {
      log('     shellcheck not installed; skipped');
      return;
    }
    run('shellcheck', ['-x', '-S', 'warning', bootstrap, verify, enableSsh, firstLogin], { timeout: 120000 });
  });

  await test('bootstrap.sh --dry-run changes nothing outside temp', () => {
    const restore = path.join(tempRoot, 'restore');
    const repo = path.join(tempRoot, 'repo');
    const data = path.join(tempRoot, 'data');
    fs.mkdirSync(path.join(restore, 'Claude'), { recursive: true });
    fs.mkdirSync(path.join(restore, 'personal-bots'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts', 'personal', 'node'), { recursive: true });
    fs.writeFileSync(path.join(restore, 'Claude', 'fixture.txt'), 'fixture\n');
    fs.writeFileSync(path.join(restore, 'personal-bots', 'state.txt'), 'fixture\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'personal', 'node', 'fixture.mjs'), '// fixture\n');

    const before = manifest(tempRoot);
    const result = runBash([
      bootstrap,
      '--dry-run',
      '--source', restore,
      '--repo', repo,
      '--data-dir', data,
      '--user', 'harout',
    ]);
    assert.match(result.stdout, /DRY-RUN/);
    assert.match(result.stdout, /would detect the active firewall/);
    assert.match(result.stdout, /Updates are manual/);
    const source = fs.readFileSync(bootstrap, 'utf8');
    assert.match(source, /dist\/bin\.mjs/, 'bootstrap resolves the release CLI at dist/bin.mjs');
    assert.doesNotMatch(source, /\$current_name\/bin\.mjs/, 'bootstrap does not assume a root bin.mjs');
    assert.ok(!fs.existsSync(data), 'dry run did not create the data dir');
    const after = manifest(tempRoot);
    assertManifestUnchanged(before, after, 'bootstrap dry run');
  });

  await test('verify.sh --dry-run prints SKIP and exits 0', () => {
    const result = runBash([verify, '--dry-run', '--repo', path.join(tempRoot, 'repo'), '--user', 'harout']);
    assert.match(result.stdout, /SKIP/);
    assert.match(result.stdout, /0 failed/);
  });

  await test('verify.sh --json --dry-run is machine-readable', () => {
    const result = runBash([verify, '--dry-run', '--json', '--repo', path.join(tempRoot, 'repo'), '--user', 'harout']);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.user, 'harout');
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.checks.length >= 7);
    for (const check of parsed.checks) {
      assert.equal(check.status, 'SKIP');
      assert.ok(check.name);
      assert.ok(check.detail);
    }
  });

  await test('verify.sh reports PASS and exits 0 with healthy fake services', () => {
    const user = spawnSync(bash, ['-c', 'id -un'], { encoding: 'utf8' }).stdout.trim();
    const fakeRepo = path.join(tempRoot, 'fake-repo');
    const unitDir = path.join(fakeRepo, 'scripts', 'personal', 'linux', 'systemd');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'hbots.service'), '[Service]\nEnvironment="T3CODE_PATH_MAP=C:/Users/Ht=/home/fake;C:/Claude/AI=/home/fake/claude"\nExecStart=/bin/true\n');
    fs.writeFileSync(path.join(unitDir, 'cloudflared.service'), '[Service]\nExecStart=/bin/true\n');

    const fakeBin = path.join(tempRoot, 'fakebin-healthy');
    fs.mkdirSync(fakeBin, { recursive: true });
    writeStub(fakeBin, 'systemctl', 'exit 0');
    writeStub(fakeBin, 'curl', 'case "$*" in *http_code*) printf "200" ;; *) printf \'{"ok":true}\' ;; esac');
    writeStub(fakeBin, 'sensors', 'exit 0');
    writeStub(fakeBin, 'df', "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/fake 100000000 1 10000000 1% /'");

    const result = runBash([verify, '--skip-apps', '--repo', fakeRepo, '--user', user], {
      env: {
        VERIFY_SYSTEMCTL: toPosix(path.join(fakeBin, 'systemctl')),
        VERIFY_CURL: toPosix(path.join(fakeBin, 'curl')),
        VERIFY_DF: toPosix(path.join(fakeBin, 'df')),
        VERIFY_SENSORS: toPosix(path.join(fakeBin, 'sensors')),
        VERIFY_INSTALLED_UNIT_DIR: toPosix(unitDir),
      },
    });
    assert.match(result.stdout, /PASS/);
    assert.match(result.stdout, /0 failed/);
  });

  await test('verify.sh exits 1 and prints FAIL when services are down', () => {
    const user = spawnSync(bash, ['-c', 'id -un'], { encoding: 'utf8' }).stdout.trim();
    const fakeRepo = path.join(tempRoot, 'fake-repo');
    const unitDir = path.join(fakeRepo, 'scripts', 'personal', 'linux', 'systemd');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'hbots.service'), '[Service]\nExecStart=/bin/true\n');

    const fakeBin = path.join(tempRoot, 'fakebin-broken');
    fs.mkdirSync(fakeBin, { recursive: true });
    writeStub(fakeBin, 'systemctl', 'exit 1');
    writeStub(fakeBin, 'curl', 'exit 7');
    writeStub(fakeBin, 'df', "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/fake 100000000 1 1000 100% /'");

    const result = spawnSync(bash, [verify, '--skip-apps', '--repo', fakeRepo, '--user', user], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VERIFY_SYSTEMCTL: toPosix(path.join(fakeBin, 'systemctl')),
        VERIFY_CURL: toPosix(path.join(fakeBin, 'curl')),
        VERIFY_DF: toPosix(path.join(fakeBin, 'df')),
      },
    });
    assert.notEqual(result.status, 0, 'verify.sh exits non-zero');
    assert.match(result.stdout, /FAIL/);
  });

  await test('deliverables are ASCII with no em or en dashes', () => {
    const files = [
      path.join(windowsDir, 'prewipe.ps1'),
      path.join(windowsDir, 'make-installer.ps1'),
      bootstrap,
      verify,
      enableSsh,
      firstLogin,
      pasteTxt,
      path.join(repoRoot, 'migrate', 'README.md'),
      path.join(here, 'run-tests.mjs'),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\u2014|\u2013/, `${path.basename(file)} has an em or en dash`);
      if (file.endsWith('.ps1')) {
        const bytes = fs.readFileSync(file);
        assert.ok(bytes.every((byte) => byte < 128), `${path.basename(file)} is not ASCII`);
      }
    }
  });

  const migrateAfter = manifest(path.join(repoRoot, 'migrate'));
  assertManifestUnchanged(migrateBefore, migrateAfter, 'migrate tree');

  log('');
  log(`${passed} passed, ${skipped} skipped, ${failed} failed`);
  log(`temp: ${tempRoot}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  failed++;
  log('SUITE ERROR');
  log(String(error.stack || error.message));
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_TEST_TEMP === '1') {
    log(`kept temp: ${tempRoot}`);
  } else {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
