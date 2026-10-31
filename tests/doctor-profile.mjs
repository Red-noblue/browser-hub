// 中文说明：验证 doctor 能显示 Profile 锁状态和持有进程，但不会输出锁 nonce 或登录资料。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-hub-doctor-'));
const entry = fileURLToPath(new URL('../bin/browser-hub', import.meta.url));
const lockRoot = path.join(temporary, 'profile-locks');

function runDoctor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), 'doctor'], {
      env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
function runStatus() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), 'status'], {
      env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

try {
  await fs.mkdir(path.join(temporary, 'data', 'profiles', 'lock-test'), { recursive: true });
  await fs.mkdir(lockRoot, { recursive: true });
  await fs.writeFile(path.join(lockRoot, 'lock-test.json'), JSON.stringify({ service: 'browser-hub', pid: process.pid, profile: 'lock-test', nonce: 'must-not-appear', created_at: '2026-01-01T00:00:00.000Z' }));
  const result = await runDoctor();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes('must-not-appear'), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.run_root, temporary);
  assert.equal(report.data_root, path.join(temporary, 'data'));
  assert.equal(report.profile_root, path.join(temporary, 'data', 'profiles'));
  const lock = report.profile_locks.find(item => item.name === 'lock-test');
  assert.equal(lock.state, 'active');
  assert.equal(lock.pid, process.pid);
  assert.equal(report.profiles.find(item => item.name === 'lock-test').lock.state, 'active');
  assert.equal(report.health.status, 'degraded');
  assert.equal(report.health.service.state, 'stopped');
  assert.equal(report.health.profile.lock.state, 'active');
  assert.equal(report.health.cache.bytes, report.bytes.profile_cache);
  assert.equal(report.health.login_profile.bytes, report.bytes.login_profile);
  assert.equal(report.health.downloads.bytes, report.bytes.downloads);
  assert.equal(report.health.test_tmp.bytes, report.bytes.test_tmp);
  assert.equal(report.health.tunnel.bytes, report.bytes.tunnel);
  assert.equal(report.health.proxy.browser.state_missing, true);
  assert.equal(typeof report.storage.cache.bytes, 'number');
  const status = await runStatus();
  assert.equal(status.code, 1);
  const statusReport = JSON.parse(status.stdout);
  assert.equal(statusReport.health.status, 'degraded');
  assert.equal(statusReport.health.profile.lock.state, 'active');
  assert.equal(typeof statusReport.storage.login_profile.bytes, 'number');
  assert.equal(typeof statusReport.storage.test_tmp.bytes, 'number');
  console.log('browser-hub doctor profile test passed');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
