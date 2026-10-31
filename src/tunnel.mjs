// 中文说明：可选的 Cloudflare 临时 HTTPS 隧道；二进制保留在项目环境，只终止本工具创建的进程。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { PROJECT_ROOT, RUNTIME_ROOT } from './paths.mjs';
import { stopChild } from './process.mjs';

const tunnelRoot = path.join(RUNTIME_ROOT, 'tunnel');
const executable = path.join(tunnelRoot, 'cloudflared');
const projectProxyLauncher = path.join(PROJECT_ROOT, 'tools', 'proxy-tunnel', 'bin', 'with-proxy.sh');
const HEALTH_INTERVAL = 15000;
const HEALTH_TIMEOUT = 8000;
const PUBLIC_WAIT_TIMEOUT = 30000;
const LAUNCH_RETRIES = 2;

// 中文说明：统一等待函数，避免隧道启动和健康检查各自实现一套退避逻辑。
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function installTunnel() {
  if (await fs.access(executable, 1).then(() => true).catch(() => false)) {
    console.log('已安装项目 cloudflared，不覆盖原文件。'); return;
  }
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!platform || !architecture) throw new Error('当前平台请自行安装 cloudflared，或使用 SSH 端口转发');
  const assetName = `cloudflared-${platform}-${architecture}${platform === 'darwin' ? '.tgz' : ''}`;
  const metadata = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { signal: AbortSignal.timeout(30000) });
  if (!metadata.ok) throw new Error(`获取官方隧道版本失败：HTTP ${metadata.status}`);
  const release = await metadata.json();
  const asset = release.assets.find(item => item.name === assetName);
  if (!asset || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('未找到对应官方 cloudflared 安装包');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-hub-tunnel-'));
  try {
    const archive = path.join(temporary, assetName);
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const data = await fs.readFile(archive);
    if (data.length !== asset.size) throw new Error('下载长度不匹配');
    if (asset.digest?.startsWith('sha256:') && `sha256:${crypto.createHash('sha256').update(data).digest('hex')}` !== asset.digest) throw new Error('隧道安装包校验失败');
    let binary = archive;
    if (platform === 'darwin') {
      execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', temporary, 'cloudflared']);
      binary = path.join(temporary, 'cloudflared');
    }
    await fs.mkdir(tunnelRoot, { recursive: true });
    await fs.copyFile(binary, executable);
    await fs.chmod(executable, 0o755);
    console.log(`已安装 cloudflared ${release.tag_name}，约 ${((await fs.stat(executable)).size / 1e6).toFixed(1)} MB`);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

// 中文说明：curl 会沿用 proxy-tunnel 注入的 HTTPS_PROXY；Node 原生 fetch 不读取该环境变量，因此两者都尝试。
async function probeWithCurl(url, timeout) {
  return new Promise(resolve => {
    const child = spawn(process.env.BROWSER_HUB_CURL || 'curl', ['--location', '--silent', '--show-error', '--max-time', String(Math.max(1, Math.ceil(timeout / 1000))), '--output', '/dev/null', '--write-out', '%{http_code}', `${url.replace(/\/$/, '')}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, error: 'curl 超时' }); }, timeout + 1000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => finish({ ok: false, error: error.code || 'curl 不可用' }));
    child.once('close', code => {
      const status = Number.parseInt(output.trim(), 10);
      finish(Number.isInteger(status) ? { ok: status >= 200 && status < 400, status } : { ok: false, error: code === 0 ? '未返回 HTTP 状态' : 'curl 连接失败' });
    });
  });
}

// 中文说明：返回公网入口的可诊断结果；HTTP 530 与 DNS/连接失败需要给出不同处理建议。
export async function probePublicUrl(url, timeout = HEALTH_TIMEOUT) {
  let fetched;
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/`, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    await response.arrayBuffer().catch(() => {});
    fetched = { ok: response.status >= 200 && response.status < 400, status: response.status };
  } catch (error) {
    fetched = { ok: false, error: error?.cause?.code || error?.code || error?.name || '网络连接失败' };
  }
  if (fetched.ok) return fetched;
  const curled = await probeWithCurl(url, timeout);
  return curled.ok ? curled : fetched.status ? { ...fetched, curl: curled.error || curled.status } : curled;
}

export async function checkPublicUrl(url, timeout = HEALTH_TIMEOUT) {
  return (await probePublicUrl(url, timeout)).ok;
}

async function waitForPublicUrl(url, timeout = PUBLIC_WAIT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probePublicUrl(url);
    if (last.ok) return;
    await delay(500);
  }
  const detail = last?.status ? `HTTP ${last.status}` : last?.error || '连接失败';
  throw new Error(`临时 HTTPS 隧道已分配域名，但公网入口不可达（${detail}）：${url}`);
}

async function launchTunnel(port, { useProxy = false, verify = true } = {}) {
  const tunnelArgs = ['--config', '/dev/null', '--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--http-host-header', `127.0.0.1:${port}`, '--protocol', 'http2'];
  const command = useProxy ? projectProxyLauncher : executable;
  const args = useProxy ? [executable, ...tunnelArgs] : tunnelArgs;
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: { ...process.env, BROWSER_HUB_TUNNEL_MODE: useProxy ? 'proxy' : 'direct' } });
  child.__browserHubDetached = true;
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('临时 HTTPS 隧道建立超时；可改用 SSH 转发')), 45000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`隧道退出：${output.slice(-800)}`)); });
      child.stderr.on('data', chunk => {
        output = (output + chunk.toString()).slice(-6000);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    if (verify) await waitForPublicUrl(url);
    return { child, url, mode: useProxy ? 'proxy-tunnel' : 'direct' };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function hasProjectProxy() {
  return fs.access(projectProxyLauncher, 1).then(() => true).catch(() => false);
}

// 中文说明：先尝试直连，再尝试项目代理；每种方式最多重试两次，避免把失效域名直接交给手机。
async function launchWithFallback(port, preference, verify = true) {
  const forceProxy = preference === true;
  const disableProxy = preference === false || process.env.BROWSER_HUB_DISABLE_PROXY_FALLBACK === '1';
  const modes = forceProxy ? [{ useProxy: true }] : [{ useProxy: false }];
  if (!disableProxy && !forceProxy && await hasProjectProxy()) modes.push({ useProxy: true });
  const errors = [];
  for (const mode of modes) {
    for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt += 1) {
      try { return await launchTunnel(port, { ...mode, verify }); }
      catch (error) {
        errors.push(`${mode.useProxy ? 'proxy-tunnel' : '直连'}第${attempt}次：${error.message}`);
        if (attempt < LAUNCH_RETRIES) await delay(800 * attempt);
      }
    }
  }
  const suggestion = forceProxy || disableProxy ? '请检查 proxy-tunnel 或改用 SSH 端口转发' : '请检查本机网络、proxy-tunnel，或改用 SSH 端口转发';
  throw new Error(`公网隧道启动失败。${errors.slice(-4).join('；')}。${suggestion}`);
}

export async function startTunnel(port, options = {}) {
  await fs.access(executable, 1).catch(() => { throw new Error('未安装可选隧道；先运行 browser-hub install-tunnel，或使用 SSH 转发'); });
  const preference = options.proxy ?? (process.env.BROWSER_HUB_TUNNEL_PROXY === '1' ? true : undefined);
  // 中文说明：serve 还没有监听本地端口时，Cloudflare 会暂时返回 502；公网验证交给 server 监听完成后的 ready()。
  let current = await launchWithFallback(port, preference, false);
  let stopped = false;
  let restarting = false;
  let failures = 0;
  let serviceReady = false;
  const listeners = new Set();
  let healthTimer;
  const notify = url => { for (const listener of listeners) Promise.resolve(listener(url)).catch(error => console.error(`公网隧道地址更新失败：${error.message}`)); };
  const attachExit = child => child.once('exit', () => {
    if (!stopped && !restarting) restart('隧道进程意外退出').catch(error => console.error(`公网隧道自动恢复失败：${error.message}`));
  });
  const restart = async reason => {
    if (stopped || restarting) return;
    restarting = true;
    const previous = current;
    try {
      console.error(`检测到公网隧道不可用（${reason}），正在自动重建……`);
      await stopChild(previous?.child);
      current = await launchWithFallback(port, preference, false);
      failures = 0;
      console.error(`公网隧道已恢复：${current.url}`);
      notify(current.url);
      attachExit(current.child);
    } catch (error) {
      failures = 0;
      console.error(`公网隧道自动恢复失败：${error.message}`);
    } finally { restarting = false; }
  };
  const ready = async () => {
    if (serviceReady) return;
    let lastError;
    for (let attempt = 0; attempt < LAUNCH_RETRIES; attempt += 1) {
      try {
        await waitForPublicUrl(current.url);
        serviceReady = true;
        return;
      } catch (error) {
        lastError = error;
        await restart('本地服务已监听但公网入口不可达');
      }
    }
    throw new Error(`公网隧道在本地服务启动后仍不可用：${lastError?.message || '连接失败'}`);
  };
  attachExit(current.child);
  healthTimer = setInterval(async () => {
    if (stopped || restarting || !serviceReady) return;
    if (await checkPublicUrl(current.url)) { failures = 0; return; }
    failures += 1;
    if (failures >= 2) await restart('连续两次公网健康检查失败');
  }, HEALTH_INTERVAL);
  healthTimer.unref?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(healthTimer);
    stopChild(current?.child).catch(() => {});
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('exit', stop);
  return {
    get url() { return current.url; },
    get mode() { return current.mode; },
    get pid() { return current.child.pid; },
    ready,
    stop,
    onUrlChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
