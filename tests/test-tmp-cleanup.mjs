// 中文说明：验证隔离测试目录清理只处理 test-tmp，不触碰 Profile、快照和下载目录。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-hub-test-tmp-'));
const entry = fileURLToPath(new URL('../bin/browser-hub', import.meta.url));
const testTmp = path.join(temporary, 'test-tmp', 'fixture');
const profile = path.join(temporary, 'data', 'profiles', 'mobile', 'Default', 'Cookies');
const snapshot = path.join(temporary, 'read-snapshots', 'keep.json');
const download = path.join(temporary, 'data', 'downloads', 'keep.webp');

function runCli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), ...args], {
      env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

try {
  await fs.mkdir(testTmp, { recursive: true });
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.mkdir(path.dirname(download), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(testTmp, 'result.json'), 'test'),
    fs.writeFile(profile, 'cookie'),
    fs.writeFile(snapshot, 'snapshot'),
    fs.writeFile(download, 'download')
  ]);
  const preview = await runCli('clean-test-tmp', '--dry-run');
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).cleaned[0].action, 'would_remove');
  assert.equal(await fs.access(testTmp).then(() => true).catch(() => false), true);
  const result = await runCli('clean-test-tmp');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cleared_bytes, 4);
  assert.equal(await fs.access(testTmp).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(profile).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(snapshot).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(download).then(() => true).catch(() => false), true);
  console.log('browser-hub test-tmp cleanup test passed');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
