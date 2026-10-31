// 中文说明：在临时运行目录验证缓存清理只删除可再生缓存，不触碰 Cookie、Local Storage、锁和下载文件。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-hub-cache-'));
const profile = path.join(temporary, 'data', 'profiles', 'cache-test');
const cache = path.join(profile, 'Default', 'Cache');
const codeCache = path.join(profile, 'Default', 'Code Cache', 'js');
const cookies = path.join(profile, 'Default', 'Cookies');
const localStorage = path.join(profile, 'Default', 'Local Storage', 'leveldb');
const downloads = path.join(temporary, 'data', 'downloads');
const entry = fileURLToPath(new URL('../bin/browser-hub', import.meta.url));

function runCli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), ...args], {
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
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(codeCache, { recursive: true });
  await fs.mkdir(path.dirname(cookies), { recursive: true });
  await fs.mkdir(localStorage, { recursive: true });
  await fs.mkdir(downloads, { recursive: true });
  await fs.writeFile(path.join(cache, 'data'), 'cache');
  await fs.writeFile(path.join(codeCache, 'data'), 'code-cache');
  await fs.writeFile(cookies, 'cookie');
  await fs.writeFile(path.join(localStorage, 'data'), 'local-storage');
  await fs.writeFile(path.join(downloads, 'image.webp'), 'download');

  const preview = await runCli('clean-cache', '--profile', 'cache-test', '--dry-run');
  assert.equal(preview.code, 0, preview.stderr);
  const previewOutput = JSON.parse(preview.stdout);
  assert.equal(previewOutput.dry_run, true);
  assert.ok(previewOutput.cleared_bytes > 0);
  assert.equal(previewOutput.cleaned.every(item => item.action === 'would_remove'), true);
  assert.equal(await fs.access(cache).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(codeCache).then(() => true).catch(() => false), true);

  const result = await runCli('clean-cache', '--profile', 'cache-test');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dry_run, false);
  assert.ok(output.cleared_bytes > 0);
  assert.equal(await fs.access(cache).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(codeCache).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(cookies).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(localStorage).then(() => true).catch(() => false), true);
  assert.equal(await fs.access(path.join(downloads, 'image.webp')).then(() => true).catch(() => false), true);
  console.log('browser-hub cache profile test passed');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
