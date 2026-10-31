// 中文说明：集中管理浏览器工具自己的路径；登录资料与源码、浏览器二进制分开保存。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
export const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PROJECT_ROOT = path.resolve(TOOL_ROOT, '../..');
export const RUN_ROOT = process.env.BROWSER_HUB_RUN_ROOT || path.join(TOOL_ROOT, 'run');
// 中文说明：运行输出与登录资料分离；测试指定 RUN_ROOT 时把数据放在其下，避免污染正式 Profile。
const RUN_ROOT_EXPLICIT = Boolean(process.env.BROWSER_HUB_RUN_ROOT);
export const DATA_ROOT = process.env.BROWSER_HUB_DATA_ROOT
  || (RUN_ROOT_EXPLICIT ? path.join(RUN_ROOT, 'data') : path.join(TOOL_ROOT, 'data'));
export const RUNTIME_ROOT = process.env.BROWSER_HUB_RUNTIME_ROOT || path.join(PROJECT_ROOT, '.venvs/browser-hub');
export const STATE_FILE = path.join(RUN_ROOT, 'session.json');
export const PROFILE_ROOT = process.env.BROWSER_HUB_PROFILE_ROOT || path.join(DATA_ROOT, 'profiles');
export const PROFILE_LOCK_ROOT = path.join(RUN_ROOT, 'profile-locks');
export const DOWNLOAD_ROOT = process.env.BROWSER_HUB_DOWNLOAD_ROOT || path.join(DATA_ROOT, 'downloads');
// 中文说明：隔离测试只使用此目录，清理时不触碰浏览器 Profile 和登录资料。
export const TEST_TMP_ROOT = path.join(RUN_ROOT, 'test-tmp');
export const MODULE_ROOT = process.env.BROWSER_HUB_NODE_MODULES || path.join(PROJECT_ROOT, '.venvs/0node_module/lib/node_modules');
// 中文说明：这些目录是 Chromium 可再生缓存；清理时不触碰 Cookie、Local Storage 和 IndexedDB。
export const CACHE_DIRECTORY_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'Media Cache', 'ShaderCache', 'GrShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'ScriptCache'
]);
export async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(name);
    else if (entry.isFile()) bytes += (await fs.stat(name)).size;
  }
  return bytes;
}
// 中文说明：递归找出 Profile 内的缓存目录，兼容 Default、Profile 1 等 Chromium Profile 名称。
export async function findCacheDirectories(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (CACHE_DIRECTORY_NAMES.has(entry.name)) {
        found.push(child);
        continue;
      }
      await visit(child);
    }
  }
  await visit(directory);
  return found;
}
// 中文说明：把目录列表的体积相加；目录可能已经不存在，因此清理后仍可安全统计。
export async function directoriesBytes(directories) {
  let bytes = 0;
  for (const directory of directories) bytes += await directoryBytes(directory);
  return bytes;
}
export async function findBrowser(explicit) {
  if (explicit || process.env.BROWSER_HUB_EXECUTABLE) return explicit || process.env.BROWSER_HUB_EXECUTABLE;
  const installed = await fs.readFile(path.join(RUNTIME_ROOT, 'installed.json'), 'utf8').then(JSON.parse).catch(() => null);
  const candidates = [
    installed?.relative_executable && path.join(RUNTIME_ROOT, installed.relative_executable),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const candidate of candidates) if (await fs.access(candidate, 1).then(() => true).catch(() => false)) return candidate;
  throw new Error('没有浏览器。运行 install-browser，或用 --browser 指定 Chromium；不会读取现有浏览器的用户资料。');
}
