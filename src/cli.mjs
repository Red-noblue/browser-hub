// 中文说明：浏览器工具的独立 CLI；登录资料不导出给 Agent，搜索和读取通过本地受保护接口完成。
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { STATE_FILE, TOOL_ROOT, RUNTIME_ROOT, RUN_ROOT, DATA_ROOT, PROFILE_ROOT, PROFILE_LOCK_ROOT, DOWNLOAD_ROOT, TEST_TMP_ROOT, MODULE_ROOT, directoryBytes, directoriesBytes, findCacheDirectories, findBrowser } from './paths.mjs';
import { failureDetails } from '../../agent-search/shared/recovery.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const print = value => {
  const output = value && typeof value === 'object' && !Array.isArray(value) && value.schema_version === undefined ? { schema_version: 1, ...value } : value;
  console.log(JSON.stringify(output, null, 2));
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
// 中文说明：比较当前源码与常驻服务启动时的时间，及时提示“代码已更新但服务未重启”。
async function currentServerSourceMtime() {
  return fs.stat(path.join(TOOL_ROOT, 'src', 'server.mjs')).then(stat => stat.mtime.toISOString()).catch(() => null);
}
const PROFILE_NAME = /^[\w-]{1,48}$/;
async function readState() {
  return JSON.parse(await fs.readFile(STATE_FILE, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw Object.assign(new Error('browser-hub 服务未启动；请先运行：bash tools/browser-hub/bin/browser-hub serve --profile mobile --tunnel'), { code: 'browser_service_stopped' });
    throw error;
  }));
}
// 中文说明：只允许操作 browser-hub 自己的 Profile，避免清理命令越过项目工作区。
function profileDirectory(name) {
  if (!PROFILE_NAME.test(name)) throw new Error('Profile 名只允许字母、数字、下划线和短横线');
  return path.join(PROFILE_ROOT, name);
}
async function profileDirectories(requested) {
  if (requested) return [{ name: requested, directory: profileDirectory(requested) }];
  const entries = await fs.readdir(PROFILE_ROOT, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => ({ name: entry.name, directory: path.join(PROFILE_ROOT, entry.name) }));
}
// 中文说明：只显示锁的诊断信息，不输出 nonce、Cookie 或任何登录资料。
async function profileLockStatus(profileName) {
  const file = path.join(PROFILE_LOCK_ROOT, `${profileName}.json`);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { path: file, exists: false, state: 'absent' };
    return { path: file, exists: true, state: 'unreadable', error: error.code || 'read_failed' };
  }
  let lock;
  try { lock = JSON.parse(raw); }
  catch { return { path: file, exists: true, state: 'corrupt' }; }
  const pid = Number(lock?.pid);
  const valid = Number.isInteger(pid) && pid > 0 && lock.profile === profileName;
  if (!valid) return { path: file, exists: true, state: 'corrupt', pid: Number.isInteger(pid) ? pid : null, profile: lock?.profile || null };
  const processAlive = alive(pid);
  return { path: file, exists: true, state: processAlive ? 'active' : 'stale', pid, profile: profileName, process_alive: processAlive, created_at: lock.created_at || null };
}
async function profileLockStatuses() {
  const names = new Set((await profileDirectories()).map(item => item.name));
  const entries = await fs.readdir(PROFILE_LOCK_ROOT, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) names.add(entry.name.replace(/\.json$/, ''));
  return Promise.all([...names].sort().map(async name => ({ name, ...(await profileLockStatus(name)) })));
}
// 中文说明：清理前检查独占锁；锁所属进程已退出时才回收陈旧锁文件。
async function assertProfileUnlocked(profileName) {
  const lockFile = path.join(PROFILE_LOCK_ROOT, `${profileName}.json`);
  const lock = await fs.readFile(lockFile, 'utf8').then(JSON.parse).catch(() => null);
  if (lock?.pid && alive(lock.pid)) throw new Error(`Profile ${profileName} 正在被 browser-hub 进程 ${lock.pid} 使用，请先停止服务`);
  if (lock) await fs.unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
// 中文说明：删除或预览 Chromium 可再生缓存；预览模式允许检查运行中的 Profile，但绝不修改文件。
async function cleanCache(requested, { dryRun = false } = {}) {
  const state = await fs.readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => null);
  if (!dryRun && state?.pid && alive(state.pid) && (!requested || state.profile === requested)) {
    throw new Error(`Profile ${state.profile || requested || '当前'} 正在使用，请先停止 browser-hub 服务后再清理缓存`);
  }
  if (!dryRun && state?.pid && alive(state.pid) && !requested) {
    throw new Error(`browser-hub 服务正在使用 Profile ${state.profile || '当前'}，请指定其他 Profile 或先停止服务`);
  }
  const profiles = await profileDirectories(requested);
  const cleaned = [];
  for (const profile of profiles) {
    const lock = await profileLockStatus(profile.name);
    if (!dryRun) await assertProfileUnlocked(profile.name);
    const directories = await findCacheDirectories(profile.directory);
    for (const directory of directories) {
      const bytes = await directoryBytes(directory);
      if (!dryRun) await fs.rm(directory, { recursive: true, force: true });
      cleaned.push({ profile: profile.name, directory, bytes, action: dryRun ? 'would_remove' : 'removed', lock_state: lock.state });
    }
  }
  return { dry_run: dryRun, requested_profile: requested || null, profiles: profiles.map(item => item.name), cleaned, cleared_bytes: cleaned.reduce((sum, item) => sum + item.bytes, 0) };
}
// 中文说明：只清理本工具隔离测试目录；不递归触碰 Profile、快照、下载或历史报告。
async function cleanTestTmp({ dryRun = false } = {}) {
  const entries = await fs.readdir(TEST_TMP_ROOT, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const cleaned = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(TEST_TMP_ROOT, entry.name);
    const bytes = await directoryBytes(directory);
    if (!dryRun) await fs.rm(directory, { recursive: true, force: true });
    cleaned.push({ directory, bytes, action: dryRun ? 'would_remove' : 'removed' });
  }
  return { dry_run: dryRun, directory: TEST_TMP_ROOT, cleaned, cleared_bytes: cleaned.reduce((sum, item) => sum + item.bytes, 0) };
}
// 中文说明：只探测已记录代理端点的 TCP 可达性，不发送业务请求，也不记录代理凭据。
async function probeProxyEndpoint(proxy) {
  if (!proxy?.enabled || !proxy.endpoint) return { configured: Boolean(proxy?.enabled), reachable: proxy?.enabled ? false : null, error: proxy?.invalid ? 'invalid_proxy_endpoint' : null };
  let parsed;
  try { parsed = new URL(proxy.endpoint); } catch { return { configured: true, reachable: false, error: 'invalid_proxy_endpoint' }; }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: parsed.hostname, port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1000, () => finish({ configured: true, reachable: false, error: 'connect_timeout' }));
    socket.once('connect', () => finish({ configured: true, reachable: true, error: null }));
    socket.once('error', error => finish({ configured: true, reachable: false, error: error.code || 'connect_failed' }));
  });
}
async function browserInstallRoot() {
  const installed = await fs.readFile(path.join(RUNTIME_ROOT, 'installed.json'), 'utf8').then(JSON.parse).catch(() => null);
  const relative = installed?.relative_executable;
  if (!relative) return null;
  const top = String(relative).split(/[\\/]/, 1)[0];
  return top ? path.join(RUNTIME_ROOT, top) : null;
}
async function profileBreakdown() {
  const profiles = await profileDirectories();
  const details = [];
  let total = 0;
  let cache = 0;
  for (const profile of profiles) {
    const profileTotal = await directoryBytes(profile.directory);
    const cacheDirectories = await findCacheDirectories(profile.directory);
    const profileCache = await directoriesBytes(cacheDirectories);
    total += profileTotal;
    cache += profileCache;
    details.push({ name: profile.name, total_bytes: profileTotal, cache_bytes: profileCache, persistent_bytes: Math.max(0, profileTotal - profileCache), lock: await profileLockStatus(profile.name) });
  }
  return { total, cache, details };
}
// 中文说明：统一收集健康检查所需的存储占用；只统计项目目录，不读取 Cookie 或登录资料内容。
async function storageSnapshot(browser) {
  const profileStats = await profileBreakdown();
  const [downloads, browserRoot, tunnel, testTmp] = await Promise.all([
    directoryBytes(DOWNLOAD_ROOT),
    browserInstallRoot(),
    directoryBytes(path.join(RUNTIME_ROOT, 'tunnel')),
    directoryBytes(TEST_TMP_ROOT)
  ]);
  const browserBytes = browserRoot ? await directoryBytes(browserRoot) : 0;
  return {
    browser: { executable: browser || null, root: browserRoot, bytes: browserBytes },
    cache: { bytes: profileStats.cache, profiles: profileStats.details.map(item => ({ name: item.name, bytes: item.cache_bytes })) },
    login_profile: { bytes: Math.max(0, profileStats.total - profileStats.cache), profiles: profileStats.details.map(item => ({ name: item.name, bytes: item.persistent_bytes })) },
    downloads: { directory: DOWNLOAD_ROOT, bytes: downloads },
    test_tmp: { directory: TEST_TMP_ROOT, bytes: testTmp },
    tunnel: { directory: path.join(RUNTIME_ROOT, 'tunnel'), bytes: tunnel },
    profiles: profileStats.details,
    profile_total_bytes: profileStats.total
  };
}
// 中文说明：服务、浏览器和源码状态使用有限探测，输出可供 CLI/MCP 直接判断的状态码。
async function healthSnapshot(state, browser, storage, observed = null) {
  const serviceRunning = Boolean(state?.pid && alive(state.pid));
  const browserRunning = Boolean(state?.browser_pid && alive(state.browser_pid));
  let local = observed?.local || null;
  let localError = observed?.error || null;
  if (serviceRunning && !observed) {
    try { local = await call('/api/status'); }
    catch (error) { localError = error.message; }
  }
  const currentSourceMtime = await currentServerSourceMtime();
  const sourceStale = Boolean(state?.source_mtime && currentSourceMtime && currentSourceMtime > state.source_mtime);
  let tunnel = { configured: Boolean(state?.public_url), reachable: null, detail: null };
  if (state?.public_url) {
    try {
      const { probePublicUrl } = await import('./tunnel.mjs');
      const probe = await probePublicUrl(state.public_url, 5000);
      tunnel = { configured: true, reachable: probe.ok, status: probe.status || null, error: probe.error || null };
    } catch (error) { tunnel = { configured: true, reachable: false, error: error.message }; }
  }
  const profileName = state?.profile || storage.profiles.find(item => item.lock?.state && item.lock.state !== 'absent')?.name || null;
  const lock = profileName ? await profileLockStatus(profileName) : null;
  const browserProxy = state?.browser_proxy || { enabled: null, argument: null, protocol: null, endpoint: null, state_missing: true };
  const proxyEndpoint = await probeProxyEndpoint(browserProxy);
  const serviceState = serviceRunning ? (local ? 'running' : 'api_unreachable') : state ? 'stale_or_stopped' : 'stopped';
  const browserState = browserRunning ? 'running' : browser ? 'stopped' : 'not_installed';
  const profileConflict = Boolean(lock && lock.state !== 'absent' && !(serviceRunning && lock.state === 'active'));
  const overall = serviceState === 'running' && browserState === 'running' && tunnel.reachable !== false && !sourceStale && !profileConflict ? 'healthy' : serviceState === 'stopped' && browserState === 'not_installed' && !profileConflict ? 'not_started' : 'degraded';
  return {
    status: overall,
    service: { state: serviceState, running: serviceRunning, pid: state?.pid || null, local_api: Boolean(local), error: localError },
    browser: { state: browserState, running: browserRunning, pid: state?.browser_pid || null, executable: browser || state?.browser || null },
    profile: { name: profileName, lock },
    cache: storage.cache,
    login_profile: storage.login_profile,
    downloads: storage.downloads,
    test_tmp: storage.test_tmp,
    proxy: { browser: { ...browserProxy, endpoint_reachable: proxyEndpoint.reachable, endpoint_error: proxyEndpoint.error }, tunnel_mode: state?.tunnel_mode || null },
    tunnel: { ...storage.tunnel, ...tunnel },
    source: { started_mtime: state?.source_mtime || null, current_mtime: currentSourceMtime, restart_required: sourceStale }
  };
}
async function call(endpoint, body) {
  const state = await readState();
  const response = await fetch(state.base_url + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }).catch(error => {
    throw Object.assign(new Error(error.name === 'TimeoutError' ? 'browser-hub 请求超时' : 'browser-hub 本地 API 不可达，请检查服务状态'), { code: error.name === 'TimeoutError' ? 'browser_timeout' : 'browser_service_unreachable' });
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), {
    code: value.code || `http_${response.status}`,
    status: response.status,
    retry_after: value.retry_after ?? response.headers.get('retry-after'),
    diagnostics: value.diagnostics || null
  });
  return value;
}
try {
  const command = args[0];
  if (command === '--version' || command === 'version') { console.log('browser-hub 0.1.0'); process.exit(0); }
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`browser-hub：独立远程浏览器与 Agent 会话工具

命令失败时 stderr 输出 JSON，包含 code、recovery 和下一步操作，退出码为1。

用法：
  bin/install-deps.sh                 安装共享 WebSocket 和轻量 Markdown 转换依赖
  browser-hub install-browser         按当前平台安装精简 Chromium，解压预算默认 400 MB
  browser-hub install-browser --target linux-x64
  browser-hub serve [--port 8791] [--profile default] [--browser /浏览器路径]
  browser-hub install-tunnel          安装可选 Cloudflare 临时 HTTPS 隧道
  browser-hub serve --tunnel          为手机提供本次运行有效的 HTTPS 接管链接（直连失败会自动尝试 proxy-tunnel）
  browser-hub serve --tunnel --proxy  强制通过项目 proxy-tunnel 建立隧道
  browser-hub serve --tunnel --no-proxy  只使用直连，不启动项目代理兜底
  browser-hub serve --stealth         显式启用无头特征兼容（默认启用；仍需遵守站点登录和使用规则）
  browser-hub serve --no-stealth      关闭无头特征兼容
  browser-hub serve --network-mode public|local [--allowed-hosts example.com,example.org]
                                      默认 public；local 仅适用于可信的本机/内网部署
  browser-hub link                    显示本次服务的接管链接
  browser-hub status                  显示服务、浏览器、隧道和当前标签页状态
  browser-hub --proxy serve           通过项目代理启动浏览器
  browser-hub read <URL>              在服务器会话中读取页面
  browser-hub read <URL> --format markdown
                                      保留标题、代码、列表、链接和常见表格
  browser-hub read <B站URL> --pages 13-17 --subtitle-language en-US --compact
  browser-hub read <B站URL> --timestamps [--start-seconds 60 --end-seconds 120]（分P内秒数，重叠整句；返回原始时间和跳转链接）
  browser-hub read <B站URL> --list-tracks [--pages 13-17]（只查分P与语言，不下载字幕正文）
  browser-hub read <URL> --snapshot <编号> --offset <next_offset> --lean
    精简续读引用首次元数据，保留正文、分页、缺失标记、警告和错误；省略 --lean 恢复完整格式。
                                      每次最多12P；精确选择语言；字幕按正文窗口分页，避免重复输出
  browser-hub read <URL> [--max-chars 8000] [--offset 0] [--snapshot <编号>]
                                      用 snapshot.id 和 next_offset 续读同一份正文
  browser-hub read <URL> --snapshot <编号> --find <原文>
                                      在快照内查找原文片段，不重新访问页面
  browser-hub read <URL> --snapshot <编号> --outline（Markdown章节与UTF-16范围，不返回正文）
  browser-hub read <URL> --snapshot <编号> --section <range.start> [--offset <next_offset>] [--lean]（只读章节，自动在章节末尾停止）
  browser-hub read <URL> --snapshot <编号> --export <项目内目录>
                                      导出全部已提取正文，只返回文件位置
  browser-hub read <URL> --download-images <目录> [--image-indexes 1,3]
                                      显式下载全部或选定小红书图片到项目工作区
                                      width/height 为清单尺寸；actual_width/actual_height 为文件实际尺寸
                                      下载失败查看 image_download.errors[].code/status/recovery
  browser-hub search <来源> <关键词>   返回页面中的结构化条目
  browser-hub clean-cache [--profile 名]
                                      清理已停止 Profile 的可再生缓存
  browser-hub clean-cache --dry-run [--profile 名]
                                      只预览可清理缓存，不修改文件
  browser-hub clean-test-tmp         清理隔离测试目录，不触碰登录资料
  browser-hub clean-test-tmp --dry-run
                                      只预览隔离测试目录，不修改文件
  browser-hub doctor                  检查运行环境、动态库及实际磁盘占用

最短排查路径：
  browser-hub status                  确认服务、浏览器和隧道状态
  browser-hub link                    获取当前运行的手机接管链接
  browser-hub search zhihu "关键词" --limit 5

浏览器常驻于 serve 前台进程，按 Ctrl+C 停止，保留 Profile。仅监听本机地址，远程使用 SSH 转发或 --tunnel HTTPS。
macOS 可直接运行 bin/browser-hub；代理分支会在当前进程注入 proxy-tunnel。若 npm 集成测试再次出现 ICU 资源错误，请按 README 的历史诊断改用直接 Node 命令排查。
工作台用于人工登录和验证；登录后 CLI/MCP 直接使用会话，无需额外点击授权。只创建工具独立 Profile，不读取系统浏览器登录资料。
Linux root 环境应优先改为普通用户；确有需要可显式传 --no-sandbox。
空间预算只计浏览器组件新增文件，不包括共享 Node、系统原有库与日后增长的站点数据。`);
  } else if (command === 'install-browser') {
    const outcome = spawnSync(process.env.BROWSER_HUB_PYTHON || 'python3', [path.join(TOOL_ROOT, 'bin/install-browser.py'), ...args.slice(1)], { stdio: 'inherit' });
    if (outcome.error) throw outcome.error;
    process.exitCode = outcome.status || 0;
  } else if (command === 'install-tunnel') {
    const { installTunnel } = await import('./tunnel.mjs');
    await installTunnel();
  } else if (command === 'clean-cache') {
    const requested = option('--profile');
    print(await cleanCache(requested, { dryRun: args.includes('--dry-run') }));
  } else if (command === 'clean-test-tmp') {
    print(await cleanTestTmp({ dryRun: args.includes('--dry-run') }));
  } else if (command === 'link') {
    let state = await readState();
    if (state.public_url) {
      const { checkPublicUrl } = await import('./tunnel.mjs');
      let reachable = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        state = await readState();
        if (state.public_url && await checkPublicUrl(state.public_url, 5000)) {
          reachable = true;
          break;
        }
        if (attempt < 3) await delay(1000);
      }
      state = await readState();
      if (!reachable) console.error('警告：当前公网链接连续多次暂时不可达；隧道服务会自动重建并更新地址，请等待约 10～30 秒后重新运行 browser-hub link。服务已停止时再重启 serve --tunnel。');
    }
    console.log(`${state.public_url || state.base_url}/#token=${state.token}`);
  } else if (command === 'serve') {
    const { serve } = await import('./server.mjs');
    const port = Number(option('--port', 8791));
    let tunnel;
    if (args.includes('--tunnel')) {
      if (!port) throw new Error('临时隧道需要固定的非零端口');
      const { startTunnel } = await import('./tunnel.mjs');
      const tunnelProxy = args.includes('--proxy') ? true : args.includes('--no-proxy') ? false : undefined;
      tunnel = await startTunnel(port, { proxy: tunnelProxy });
    }
    try {
      const networkMode = option('--network-mode', process.env.BROWSER_HUB_NETWORK_MODE || 'public');
      if (!['public', 'local'].includes(networkMode)) throw new Error('--network-mode 只能是 public 或 local');
      const allowedHosts = String(option('--allowed-hosts', process.env.BROWSER_HUB_ALLOWED_HOSTS || '')).split(',').map(item => item.trim()).filter(Boolean);
      await serve({ port, profile: option('--profile', 'default'), browser: option('--browser'), noSandbox: args.includes('--no-sandbox'), stealth: !args.includes('--no-stealth') && (args.includes('--stealth') || process.env.BROWSER_HUB_STEALTH !== '0'), publicUrl: tunnel?.url || option('--public-url'), networkPolicy: { mode: networkMode, allowedHosts }, tunnel, onClose: tunnel?.stop });
    } catch (error) { tunnel?.stop(); throw error; }
  } else if (command === 'status') {
    const state = await readState().catch(error => ({ error: error.message }));
    if (state.error) {
      const browser = await findBrowser().catch(() => null);
      const storage = await storageSnapshot(browser);
      const health = await healthSnapshot(null, browser, storage);
      print({ ok: false, service: { running: false }, health, storage, error: state.error });
      process.exitCode = 1;
    } else {
      const serviceAlive = alive(state.pid);
      const browserAlive = alive(state.browser_pid);
      let local = null;
      let localError = null;
      if (serviceAlive) {
        try { local = await call('/api/status'); }
        catch (error) { localError = error.message; }
      }
      let publicReachable = null;
      let publicProbeAttempts = 0;
      let publicUrl = state.public_url || null;
      if (state.public_url) {
        const { checkPublicUrl } = await import('./tunnel.mjs');
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          publicProbeAttempts = attempt;
          publicUrl = (await readState()).public_url || publicUrl;
          publicReachable = await checkPublicUrl(publicUrl, 5000);
          if (publicReachable || attempt === 3) break;
          await delay(1000);
        }
      }
      const currentSourceMtime = await currentServerSourceMtime();
      const storage = await storageSnapshot(state.browser || null);
      const health = await healthSnapshot(state, state.browser || null, storage, { local, error: localError });
      const snapshot = {
        ok: serviceAlive && browserAlive && Boolean(local) && (publicReachable !== false),
        service: { running: serviceAlive, pid: state.pid, base_url: state.base_url, state_file: STATE_FILE, started_at: state.started_at || null, source_mtime: state.source_mtime || null, current_source_mtime: currentSourceMtime, source_newer_than_service: Boolean(state.source_mtime && currentSourceMtime && currentSourceMtime > state.source_mtime) },
        browser: { running: browserAlive, pid: state.browser_pid, executable: state.browser, proxy_server: state.browser_proxy || null },
        tunnel: publicUrl ? { configured: true, public_url: publicUrl, reachable: publicReachable, probe_attempts: publicProbeAttempts } : { configured: false, reachable: null, probe_attempts: 0 },
        session: { profile: state.profile, profile_lock: await profileLockStatus(state.profile) },
        local: local || { reachable: false, error: localError || '本地服务不可达' },
        storage,
        health
      };
      print(snapshot);
      if (!snapshot.ok) process.exitCode = 1;
    }
  }
  else if (command === 'read') {
    for (const name of ['--pages', '--subtitle-language', '--start-seconds', '--end-seconds', '--section']) if (args.includes(name) && (!option(name) || option(name).startsWith('--'))) throw new Error(`${name} 缺少参数`);
    if (args.includes('--timestamps') && args.includes('--no-timestamps')) throw new Error('timestamps 选项不能同时开启和关闭');
    if (args.includes('--compact') && args.includes('--no-compact')) throw new Error('compact 选项不能同时开启和关闭');
    const result = await call('/api/read', { url: args[1], source: option('--source'), max_chars: Number(option('--max-chars', 8000)), offset: option('--offset'), format: option('--format'), snapshot_id: option('--snapshot'), find: option('--find'), outline: args.includes('--outline'), section_start: option('--section'), export_directory: option('--export'), download_images: option('--download-images'), image_indexes: option('--image-indexes'), pages: option('--pages'), subtitle_language: option('--subtitle-language'), compact: args.includes('--compact') ? true : args.includes('--no-compact') ? false : undefined, lean: args.includes('--lean'), list_tracks: args.includes('--list-tracks'), timestamps: args.includes('--timestamps') ? true : args.includes('--no-timestamps') ? false : undefined, start_seconds: option('--start-seconds'), end_seconds: option('--end-seconds') });
    if (args.includes('--section') && (result.section?.range?.start !== Number(option('--section')) || result.content_window?.scope !== 'section')) throw Object.assign(new Error('browser-hub 未返回选定章节；请更新并重启服务'), { code: 'browser_update_required' });
    if (args.includes('--lean') && result.response_mode !== 'lean') throw Object.assign(new Error('browser-hub 未返回精简快照响应；请更新并重启服务'), { code: 'browser_update_required' });
    if (args.includes('--list-tracks') && result.response_mode !== 'catalog') throw Object.assign(new Error('browser-hub 未返回轨道清单；请更新并重启服务'), { code: 'browser_update_required' });
    if ((args.includes('--timestamps') || args.includes('--start-seconds') || args.includes('--end-seconds')) && !result.subtitle_timing) throw Object.assign(new Error('browser-hub 未返回字幕时间信息；请更新并重启服务；旧快照需重新读取'), { code: 'browser_update_required' });
    print(result);
  }
  else if (command === 'search') {
    const queryArgs = args.slice(2).filter((arg, index, all) => !arg.startsWith('--') && !(index > 0 && all[index - 1].startsWith('--')));
    print(await call('/api/search', { source: args[1], query: queryArgs.join(' '), limit: Number(option('--limit', 10)) }));
  }
  else if (command === 'doctor') {
    const browser = await findBrowser(option('--browser')).catch(() => null);
    const runtime = await directoryBytes(RUNTIME_ROOT);
    const runBytes = await directoryBytes(RUN_ROOT);
    const dataBytes = await directoryBytes(DATA_ROOT);
    const storage = await storageSnapshot(browser);
    const state = await fs.readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => null);
    const health = await healthSnapshot(state, browser, storage);
    const downloads = storage.downloads.bytes;
    const browserBytes = storage.browser.bytes;
    const tunnelBytes = storage.tunnel.bytes;
    const dependencies = await directoryBytes(path.join(MODULE_ROOT, 'ws'));
    const markdownDependencies = await directoriesBytes(['turndown', 'turndown-plugin-gfm'].map(name => path.join(MODULE_ROOT, name)));
    const total = runtime + runBytes + dataBytes + dependencies + markdownDependencies + await directoryBytes(path.join(TOOL_ROOT, 'src')) + await directoryBytes(path.join(TOOL_ROOT, 'web')) + await directoryBytes(path.join(TOOL_ROOT, '../agent-search/shared'));
    const libraries = process.platform === 'linux' && browser ? spawnSync('ldd', [browser], { encoding: 'utf8' }).stdout?.split('\n').filter(line => line.includes('not found')) || [] : [];
    print({
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      browser,
      runtime_root: RUNTIME_ROOT,
      run_root: RUN_ROOT,
      data_root: DATA_ROOT,
      profile_root: PROFILE_ROOT,
      bytes: {
        browser_runtime: runtime,
        browser: browserBytes,
        tunnel: tunnelBytes,
        run: runBytes,
        data: dataBytes,
        profiles_and_state: storage.profile_total_bytes,
        profile_total: storage.profile_total_bytes,
        profile_cache: storage.cache.bytes,
        login_profile: storage.login_profile.bytes,
        downloads,
        test_tmp: storage.test_tmp.bytes,
        ws: dependencies,
        markdown_dependencies: markdownDependencies,
        read_snapshots: await directoryBytes(path.join(RUN_ROOT, 'read-snapshots')),
        component_total: total
      },
      profiles: storage.profiles,
      profile_locks: await profileLockStatuses(),
      storage,
      health,
      budget_bytes: 500000000,
      within_budget: total < 500000000,
      system_libraries_missing: libraries,
      note: 'browser 为项目内置 Chromium 目录；复用外部浏览器时不计其既有安装体积。data 保存登录 Profile 和用户下载文件，不能随意删除；run 只保存会话状态、锁、快照和临时输出，可在服务停止后清理。login_profile 是登录资料及其他非缓存 Profile 数据的合计，包含 Cookie、Local Storage、IndexedDB，未整体加密，不进入常规项目发布包。clean-cache 只清理 profile_cache；clean-test-tmp 只清理隔离测试目录。'
    });
  } else throw new Error('未知命令；请运行 browser-hub help');
} catch (error) {
  const details = failureDetails(error);
  if (error.diagnostics) details.diagnostics = error.diagnostics;
  console.error(JSON.stringify({ error: error.message, ...details }));
  process.exitCode = 1;
}
