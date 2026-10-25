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
const testPassword = 'SELFTEST-ONLY-password-9f3a';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hbots-migrate-tests-'));
const cidataImage = path.join(tempRoot, 'cidata.img');
let passed = 0;
let failed = 0;
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

function readFat32(imagePath) {
  const bytes = fs.readFileSync(imagePath);
  const u16 = (offset) => bytes.readUInt16LE(offset);
  const u32 = (offset) => bytes.readUInt32LE(offset);

  assert.equal(u16(510), 0xaa55, 'cidata boot sector signature');
  const bytesPerSector = u16(11);
  assert.equal(bytesPerSector, 512, 'cidata sector size');
  const sectorsPerCluster = bytes[13];
  const reservedSectors = u16(14);
  const fatCount = bytes[16];
  const fatSectors = u32(36);
  const rootCluster = u32(44);
  const clusterSize = bytesPerSector * sectorsPerCluster;
  const dataStartSector = reservedSectors + fatCount * fatSectors;
  const volumeLabel = bytes.subarray(71, 82).toString('ascii').trim();
  const fsType = bytes.subarray(82, 90).toString('ascii').trim();
  assert.equal(volumeLabel, 'CIDATA', 'cidata volume label');
  assert.equal(fsType, 'FAT32', 'cidata filesystem type');

  const fatEntries = Math.floor((fatSectors * bytesPerSector) / 4);
  const fatOffset = reservedSectors * bytesPerSector;
  const fat = (cluster) => {
    if (cluster < 0 || cluster >= fatEntries) {
      throw new Error(`FAT cluster out of range: ${cluster}`);
    }
    return u32(fatOffset + cluster * 4) & 0x0fffffff;
  };

  const clusterOffset = (cluster) => (dataStartSector + (cluster - 2) * sectorsPerCluster) * bytesPerSector;

  function chain(start) {
    const result = [];
    const seen = new Set();
    let cluster = start;
    while (cluster >= 2 && cluster < fatEntries && !seen.has(cluster)) {
      seen.add(cluster);
      result.push(cluster);
      const next = fat(cluster);
      if (next >= 0x0ffffff8) {
        break;
      }
      cluster = next;
    }
    return result;
  }

  function lfnChunk(entry) {
    const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    let text = '';
    for (const position of positions) {
      const unit = entry.readUInt16LE(position);
      if (unit === 0 || unit === 0xffff) {
        continue;
      }
      text += String.fromCharCode(unit);
    }
    return text;
  }

  function shortName(entry) {
    const base = entry.subarray(0, 8).toString('ascii').trim();
    const ext = entry.subarray(8, 11).toString('ascii').trim();
    return ext ? `${base}.${ext}` : base;
  }

  const files = new Map();
  let lfn = new Map();
  let done = false;

  for (const cluster of chain(rootCluster)) {
    if (done) {
      break;
    }
    const base = clusterOffset(cluster);
    for (let offset = 0; offset < clusterSize; offset += 32) {
      const entry = bytes.subarray(base + offset, base + offset + 32);
      if (entry[0] === 0) {
        done = true;
        break;
      }
      const attr = entry[11];
      if (attr === 0x0f) {
        const order = entry[0] & 0x3f;
        lfn.set(order, lfnChunk(entry));
        continue;
      }
      if (attr === 0x08) {
        continue;
      }
      if ((attr & 0x10) !== 0 || attr !== 0x20) {
        continue;
      }

      let name = shortName(entry);
      if (lfn.size > 0) {
        name = [...lfn.keys()].sort((a, b) => a - b).map((key) => lfn.get(key)).join('');
        lfn = new Map();
      }

      const high = entry.readUInt16LE(20);
      const low = entry.readUInt16LE(26);
      const startCluster = (high << 16) | low;
      const size = entry.readUInt32LE(28);
      const data = Buffer.alloc(size);
      let written = 0;
      if (size > 0) {
        for (const fileCluster of chain(startCluster)) {
          const fileOffset = clusterOffset(fileCluster);
          const take = Math.min(clusterSize, size - written);
          bytes.copy(data, written, fileOffset, fileOffset + take);
          written += take;
          if (written >= size) {
            break;
          }
        }
      }
      assert.equal(written, size, `cidata file ${name} is complete`);
      files.set(name, data);
    }
  }

  return { volumeLabel, fsType, files, imageSize: bytes.length };
}

function assertNoPlaintextPassword(buffer, label) {
  const ascii = buffer.toString('latin1');
  if (ascii.includes(testPassword)) {
    throw new Error(`${label}: plaintext test password found as ASCII`);
  }
  if (buffer.includes(Buffer.from(testPassword, 'utf16le'))) {
    throw new Error(`${label}: plaintext test password found as UTF-16LE`);
  }
}

function parseJsonFile(files, name) {
  assert.ok(files.has(name), `cidata has ${name}`);
  const text = files.get(name).toString('utf8');
  return JSON.parse(text);
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

  await test('prewipe.ps1 -SelfTest exits 0', () => {
    const result = runPwsh(prewipe, ['-SelfTest']);
    assert.match(result.stdout, /SELFTEST PASS/);
    assert.doesNotMatch(result.stdout, /SELFTEST FAIL/);
  });

  await test('make-installer.ps1 -SelfTest exits 0', () => {
    const result = runPwsh(makeInstaller, ['-SelfTest']);
    assert.match(result.stdout, /SELFTEST PASS/);
    assert.doesNotMatch(result.stdout, /SELFTEST FAIL/);
  });

  await test('make-installer builds a readable CIDATA image with no plaintext password', () => {
    const result = runPwsh(makeInstaller, ['-ImageFile', cidataImage, '-BuildCidataOnly', '-SelfTest']);
    assert.match(result.stdout, /SELFTEST PASS/);
    assert.doesNotMatch(result.stdout, new RegExp(testPassword));
    assert.ok(fs.existsSync(cidataImage), 'cidata image exists');
    assert.ok(fs.statSync(cidataImage).size >= 48 * 1024 * 1024, 'cidata image is at least 48 MB');

    const image = readFat32(cidataImage);
    assert.equal(image.volumeLabel, 'CIDATA');
    assert.equal(image.fsType, 'FAT32');

    for (const name of [
      'user_configuration.json',
      'user_credentials.json',
      'user_encrypt_installation.txt',
      'authorized_keys',
      'hostname',
    ]) {
      assert.ok(image.files.has(name), `cidata image contains ${name}`);
    }

    const config = parseJsonFile(image.files, 'user_configuration.json');
    for (const key of [
      'hostname',
      'disk_config',
      'omarchy_install',
      'bootloader_config',
      'locale_config',
      'timezone',
      'kernels',
      'version',
      'packages',
      'mirror_config',
      'network_config',
      'swap',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(config, key), `user_configuration.json has ${key}`);
    }
    assert.equal(config.hostname, 'hbots');
    assert.equal(config.timezone, 'Europe/London');
    assert.equal(config.locale_config.kb_layout, 'gb');
    assert.equal(config.bootloader_config.bootloader, 'Limine');
    assert.equal(config.omarchy_install.mode, 'full_disk');
    assert.equal(config.omarchy_install.storage.kernel, 'linux-omarchy');
    assert.equal(config.disk_config.device_modifications[0].device, '/dev/nvme0n1');
    assert.equal(config.disk_config.device_modifications[0].wipe, true);
    assert.equal(config.disk_config.device_modifications[0].partitions.length, 2);
    assert.ok(Array.isArray(config.packages));
    assert.ok(config.packages.includes('base-devel'));
    assert.ok(config.kernels.includes('linux-omarchy'));
    assert.doesNotMatch(JSON.stringify(config), /"password"/i);
    assert.doesNotMatch(JSON.stringify(config), new RegExp(testPassword));

    const credentials = parseJsonFile(image.files, 'user_credentials.json');
    assert.ok(Array.isArray(credentials.users));
    assert.equal(credentials.users.length, 1);
    assert.equal(credentials.users[0].username, 'harout');
    assert.equal(credentials.users[0].sudo, true);
    assert.match(credentials.users[0].enc_password, /^\$6\$/);
    assert.match(credentials.root_enc_password, /^\$6\$/);
    assert.ok(!String(credentials.users[0].enc_password).includes(testPassword));

    const keys = image.files.get('authorized_keys').toString('utf8');
    assert.match(keys, /^ssh-ed25519 /);
    assert.match(keys, /selftest@example/);

    const hostname = image.files.get('hostname').toString('utf8').trim();
    assert.equal(hostname, 'hbots');

    const encrypt = image.files.get('user_encrypt_installation.txt').toString('utf8').trim();
    assert.equal(encrypt, 'false');

    const raw = fs.readFileSync(cidataImage);
    assertNoPlaintextPassword(raw, 'cidata image');
  });

  await test('bash -n accepts bootstrap.sh and verify.sh', () => {
    runBash(['-n', bootstrap]);
    runBash(['-n', verify]);
  });

  await test('shellcheck passes when installed', () => {
    const available = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
    if (available.error || available.status !== 0) {
      log('     shellcheck not installed; skipped');
      return;
    }
    run('shellcheck', ['-x', '-S', 'warning', bootstrap, verify], { timeout: 120000 });
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
    fs.writeFileSync(path.join(unitDir, 'hbots.service'), '[Service]\nExecStart=/bin/true\n');
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
  log(`${passed} passed, ${failed} failed`);
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
