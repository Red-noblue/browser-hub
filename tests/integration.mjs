// 中文说明：使用独立临时 Profile 验证真实 Chromium 的接口鉴权、Profile 锁、免手动授权读取、手机方向按钮、键鼠、画面和 Cookie 重启持久化；不读取用户账号。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Cdp } from '../src/cdp.mjs';

const testRoot = fileURLToPath(new URL('../run/test-tmp/', import.meta.url));
await fs.mkdir(testRoot, { recursive: true });
const temporary = await fs.mkdtemp(path.join(testRoot, 'browser-hub-integration-'));
const structuredFixture = await fs.readFile(new URL('../../agent-search/tests/fixtures/structured.html', import.meta.url), 'utf8');
let changingVersion = '首版';
let changingRequests = 0;
let structuredRequests = 0;
const imageFixtures = new Map();
const fixture = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (imageFixtures.has(request.url)) {
    const image = imageFixtures.get(request.url);
    response.setHeader('content-type', image.type);
    response.end(image.data);
    return;
  }
  if (request.url === '/interrupted.png') {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': 1000 });
    response.write(Buffer.from('89504e470d0a1a0a', 'hex'));
    setTimeout(() => response.destroy(), 25);
    return;
  }
  if (request.url === '/limited.png') {
    response.writeHead(429, { 'retry-after': '7' });
    response.end('限流夹具');
    return;
  }
  if (request.url === '/structured') { structuredRequests++; response.end(structuredFixture); return; }
  if (request.url === '/changing') {
    changingRequests += 1;
    response.end('<main>' + changingVersion.repeat(30000) + '😀结束</main>');
    return;
  }
  if (request.url === '/image.png') {
    response.setHeader('content-type', 'image/png');
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4AWJiYGD4D8IgBpBmYIAzAAAAAP//bxDlJQAAAAZJREFUAwAqXQIFX9UP2gAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  if (request.url === '/broken.png') {
    response.setHeader('content-type', 'image/png');
    response.end('这是损坏的图片文件');
    return;
  }
  if (request.url === '/set') response.setHeader('set-cookie', 'hub_fixture=persisted; Max-Age=3600; Path=/');
  if (request.url === '/nested') {
    response.end('<!doctype html><title>内部滚动容器</title><div id="nested" style="position:absolute;top:350px;left:0;width:100%;height:300px;overflow:auto"><div style="height:4000px">内部长页面</div></div>');
    return;
  }
  if (request.url === '/blocked') {
    response.end('<!doctype html><title>拦截滚轮</title><p style="height:4000px">拦截滚轮测试</p><script>addEventListener("wheel",event=>event.preventDefault(),{passive:false})</script>');
    return;
  }
  if (request.url === '/slow') {
    setTimeout(() => response.end('<!doctype html><title>慢速读取</title><p>并发队列测试</p>'), 900);
    return;
  }
  if (request.url === '/long') {
    response.end('<!doctype html><title>分段正文</title><main><h2>章节一</h2><p>第一段内容完整保留。</p><ul><li>列表项目甲</li><li>列表项目乙</li></ul><p>' + '连续正文。'.repeat(60) + '</p><h2>章节二</h2><p>末尾校验标记。</p></main>');
    return;
  }
  if (request.url === '/unicode') {
    response.end('<!doctype html><main>' + 'a'.repeat(199) + '😀中文正文'.repeat(80) + '</main>');
    return;
  }
  if (request.url === '/queue') {
    setTimeout(() => response.end(`<!doctype html><title>队列上限读取</title><p>${'队列上限测试正文，用于让浏览器读取在第一次检查时完成并稳定验证 429 重试响应。'.repeat(8)}</p>`), 200);
    return;
  }
  if (request.url === '/horizontal') {
    response.end('<!doctype html><title>横向滚动</title><body style="margin:0;width:4000px;height:1000px"><div style="width:3900px;height:900px">二维码左侧横向内容</div></body>');
    return;
  }
  response.end('<!doctype html><title>浏览器会话测试</title><input id="text" style="position:absolute;left:20px;top:20px;width:240px;height:40px"><p style="margin-top:100px;height:4000px">仅供本地浏览器接管测试</p><script>document.body.append(document.createTextNode(document.cookie));</script>');
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
const nestedUrl = `${fixtureUrl}nested`;
const blockedUrl = `${fixtureUrl}blocked`;
const horizontalUrl = `${fixtureUrl}horizontal`;
let service;
let state;
let logs = '';
let pageCdp;
let workbenchCdp;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  logs = '';
  const entry = fileURLToPath(new URL('../bin/browser-hub', import.meta.url));
  service = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), 'serve', '--port', '0', '--profile', 'test', '--public-url', 'https://phone.example.test'], { env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary, BROWSER_HUB_NETWORK_MODE: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', chunk => { logs += chunk; });
  service.stderr.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    if (service.exitCode !== null || service.signalCode !== null) throw new Error('真实浏览器服务提前退出：' + logs.replace(/token=[\w-]+/g, 'token=***'));
    state = await fs.readFile(path.join(temporary, 'session.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (state?.pid) return;
    await delay(100);
  }
  throw new Error('浏览器测试启动超时');
}
async function stop() {
  if (!service || service.exitCode !== null) return;
  const exited = once(service, 'exit'); service.kill('SIGTERM');
  const timeout = setTimeout(() => service.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function startDuplicateWithoutState() {
  const entry = fileURLToPath(new URL('../bin/browser-hub', import.meta.url));
  const duplicate = spawn(process.platform === 'darwin' ? '/bin/bash' : entry, [...(process.platform === 'darwin' ? [entry] : []), 'serve', '--port', '0', '--profile', 'test', '--public-url', 'https://phone.example.test'], { env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary, BROWSER_HUB_NETWORK_MODE: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let duplicateLogs = '';
  duplicate.stdout.on('data', chunk => { duplicateLogs += chunk; });
  duplicate.stderr.on('data', chunk => { duplicateLogs += chunk; });
  const [code] = await once(duplicate, 'exit');
  return { code, logs: duplicateLogs };
}
async function api(endpoint, body, headers = {}) {
  return fetch(state.base_url + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
}
try {
  await start();
  // GPU 子进程异常曾导致“刚启动就成功”的假阳性；先要求浏览器稳定存活。
  await delay(6000);
  assert.equal(service.exitCode, null, logs.replace(/token=[\w-]+/g, 'token=***'));
  assert.equal((await fetch(state.base_url + '/api/status')).status, 401);
  assert.equal((await api('/api/status', undefined, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await api('/api/status', undefined, { origin: 'https://phone.example.test' })).status, 200);
  const initialStatus = await (await api('/api/status')).json();
  assert.equal(initialStatus.browser_restart_count, 0, '启动阶段不应靠崩溃重启掩盖初始化失败');
  assert.equal(initialStatus.queue_limit, 8, '状态应公开读取队列上限');
  assert.equal(initialStatus.tabs.some(tab => tab.url === 'about:blank'), false, '启动页不应显示 about:blank');
  assert.equal(initialStatus.tabs.some(tab => tab.title === '等待操作'), true, '启动页欢迎内容缺失');
  // 模拟状态文件丢失：第二个服务仍必须被原子 Profile 锁拒绝，避免两个 Chromium 共用登录资料。
  await fs.unlink(path.join(temporary, 'session.json'));
  const duplicate = await startDuplicateWithoutState();
  assert.notEqual(duplicate.code, 0, '同一 Profile 的第二个服务不应启动');
  assert.match(duplicate.logs, /Profile test 已被 browser-hub 进程 .* 使用/, '第二个服务应报告 Profile 锁冲突');
  assert.equal(service.exitCode, null, '原服务不应被第二个服务影响');
  // 中文说明：状态丢失用例结束后恢复本轮私有会话，供后续真实CLI读取，不接触用户服务。
  await fs.writeFile(path.join(temporary, 'session.json'), JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  const directRead = await api('/api/read', { url: fixtureUrl });
  assert.equal(directRead.status, 200, '读取不应要求工作台手动授权');
  const directReadValue = await directRead.json();
  assert.match(directReadValue.content, /仅供本地浏览器接管测试/);
  assert.equal(directReadValue.diagnostics.site, 'generic');
  assert.ok(directReadValue.diagnostics.attempts >= 1, '读取应返回页面检查次数');
  assert.equal(directReadValue.content_window.offset, 0);
  assert.equal(directReadValue.content_window.has_more, false);
  const structuredRead = await (await api('/api/read', { url: fixtureUrl + 'structured', format: 'markdown', max_chars: 50000 })).json();
  assert.match(structuredRead.content, /```python\ndef compare\(a, b\):\n    if a < b:/);
  assert.match(structuredRead.content, /\| 名称 \| 值 \|/);
  assert.match(structuredRead.content, /\[参考链接\]\(http:/);
  assert.doesNotMatch(structuredRead.content, /脚本不应输出|隐藏元素不应输出/);
  assert.equal(structuredRead.content_format, 'markdown');
  const beforeOutline = structuredRequests;
  const outline = await (await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id, outline: true })).json();
  assert.equal(outline.content, null);
  assert.equal(outline.outline.supported, true);
  assert.ok(outline.outline.sections.length > 0);
  assert.equal(outline.provenance.content_sha256, structuredRead.provenance.content_sha256);
  const section = outline.outline.sections.at(-1);
  const located = await (await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id, offset: section.range.start, max_chars: 200, lean: true })).json();
  assert.equal(located.content, structuredRead.content.slice(section.range.start, section.range.start + 200));
  assert.equal(structuredRequests, beforeOutline, '目录及定位续读不能再次导航或改写快照');
  for (const section of outline.outline.sections) {
    const response = await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id, section_start: section.range.start, lean: true });
    assert.equal(response.status, 200);
    const selected = await response.json();
    assert.equal(selected.content, structuredRead.content.slice(section.range.start, section.range.end));
    assert.equal(selected.content_window.scope, 'section');
    assert.equal(selected.content_window.next_offset, null);
    assert.equal(selected.section.range.start, section.range.start);
  }
  const sectionCli = JSON.parse((await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'read', fixtureUrl + 'structured', '--snapshot', structuredRead.snapshot.id, '--section', String(section.range.start), '--lean'], { env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary } })).stdout);
  assert.equal(sectionCli.content, structuredRead.content.slice(section.range.start, section.range.end), 'CLI未指定offset时应从章节开始');
  assert.equal(sectionCli.content_window.scope, 'section');
  const chapterRead = await (await api('/api/read', { url: fixtureUrl + 'long', format: 'markdown', max_chars: 50000 })).json();
  const chapterOutline = await (await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: chapterRead.snapshot.id, outline: true })).json();
  const chapter = chapterOutline.outline.sections[0];
  let chapterOffset, chapterJoined = '';
  do {
    const window = await (await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: chapterRead.snapshot.id, section_start: chapter.range.start, offset: chapterOffset, max_chars: 200, lean: true })).json();
    chapterJoined += window.content; chapterOffset = window.content_window.next_offset;
  } while (chapterOffset !== null);
  assert.equal(chapterJoined, chapterRead.content.slice(chapter.range.start, chapter.range.end));
  assert.doesNotMatch(chapterJoined, /章节二|末尾校验标记/, '长章节续读不应越过同级标题');
  for (const extra of [{ snapshot_id: undefined }, { section_start: -1 }, { section_start: 1 }, { offset: structuredRead.content.length + 1 }, { outline: true }, { find: '标题' }, { export_directory: temporary }, { download_images: temporary }]) {
    assert.equal((await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id, section_start: section.range.start, ...extra })).status, 400);
  }
  assert.equal(structuredRequests, beforeOutline, '章节读取和非法参数不能重新导航');
  for (const extra of [{ snapshot_id: undefined }, { outline: 'true' }, { find: '标题' }, { lean: true }, { export_directory: temporary }, { download_images: temporary }]) {
    assert.equal((await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id, outline: true, ...extra })).status, 400);
  }
  const changingRead = await (await api('/api/read', { url: fixtureUrl + 'changing', max_chars: 50000 })).json();
  assert.equal(changingRead.content_window.total_chars, 60004);
  changingVersion = '新版';
  const previousRequests = changingRequests;
  const continued = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, offset: changingRead.content_window.next_offset, max_chars: 50000 })).json();
  assert.equal(changingRequests, previousRequests, '快照续读不应再次导航');
  assert.equal(changingRead.content + continued.content, '首版'.repeat(30000) + '😀结束');
  assert.equal(changingRead.provenance.content_sha256, continued.provenance.content_sha256);
  const found = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, find: '😀结束', max_chars: 200 })).json();
  assert.equal(found.content, null);
  assert.equal(found.find.total_matches, 1);
  assert.deepEqual(found.matches[0].match_range, { start: 60000, end: 60004 });
  const saved = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, export_directory: path.join(temporary, 'export') })).json();
  assert.equal(saved.content, null);
  assert.equal(saved.exported.chars, 60004);
  assert.equal(await fs.readFile(saved.exported.content_file, 'utf8'), '首版'.repeat(30000) + '😀结束');
  assert.equal(changingRequests, previousRequests, '快照查找和导出都不应重新导航');
  assert.equal((await api('/api/read', { url: fixtureUrl + 'changing', find: '首版' })).status, 400);
  assert.equal((await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, find: ' ' })).status, 400);
  assert.equal((await api('/api/read', { url: fixtureUrl + 'other', snapshot_id: changingRead.snapshot.id })).status, 400);
  assert.equal((await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, format: 'markdown' })).status, 400);
  assert.equal((await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, source: 'zhihu' })).status, 400);
  // 用本次隔离快照模拟图片清单，验证真实下载只处理指定编号且不重新访问页面。
  const snapshotFile = path.join(temporary, 'read-snapshots', changingRead.snapshot.id + '.json');
  const imageRecord = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
  imageRecord.result.images = [{ index: 1, url: fixtureUrl + 'image.png' }, { index: 2, url: fixtureUrl + 'image.png', width: 4, height: 6 }, { index: 3, url: fixtureUrl + 'broken.png', width: 2, height: 3 }];
  await fs.writeFile(snapshotFile, JSON.stringify(imageRecord));
  const imageDirectory = path.join(temporary, 'selected-images');
  const beforeImages = await (await api('/api/status')).json();
  const selected = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: imageDirectory, image_indexes: [2] })).json();
  assert.equal(selected.image_download.downloaded.length, 1);
  assert.equal(selected.image_download.downloaded[0].index, 2);
  const resized = selected.image_download.downloaded[0];
  assert.deepEqual([resized.width, resized.height, resized.actual_width, resized.actual_height], [4, 6, 2, 3]);
  assert.equal(resized.decoded, true);
  assert.equal(resized.manifest_dimensions_match, false);
  assert.ok(selected.warnings.some(warning => warning.includes('actual_width/actual_height')), '缩放图片需明确提醒尺寸差异');
  assert.deepEqual(await fs.readdir(imageDirectory), ['02.png']);
  const damaged = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: path.join(temporary, 'damaged-images'), image_indexes: [1, 3] })).json();
  assert.equal(damaged.image_download.errors.length, 0, '解码失败仍保留已下载文件');
  const [unknown, broken] = damaged.image_download.downloaded;
  assert.deepEqual([unknown.actual_width, unknown.actual_height, unknown.manifest_dimensions_match], [2, 3, null]);
  assert.deepEqual([broken.actual_width, broken.actual_height, broken.manifest_dimensions_match], [null, null, null]);
  assert.equal(broken.decoded, false);
  assert.equal(broken.decode_error, 'image_decode_failed');
  assert.equal(await fs.readFile(broken.file, 'utf8'), '这是损坏的图片文件');
  assert.ok(damaged.warnings.some(warning => warning.includes('decode_error')));
  const afterImages = await (await api('/api/status')).json();
  assert.deepEqual(afterImages.tabs.map(tab => tab.id).sort(), beforeImages.tabs.map(tab => tab.id).sort(), '下载后关闭自建解码标签页');
  assert.equal(afterImages.active_id, beforeImages.active_id, '解码不切换人工接管页面');
  assert.equal(changingRequests, previousRequests, '快照图片下载不重新导航正文');
  assert.equal((await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: imageDirectory, image_indexes: [4] })).status, 400);
  assert.equal((await api('/api/read', { url: fixtureUrl, format: 'html' })).status, 400);
  const repeated = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: imageDirectory, image_indexes: [2] })).json();
  assert.equal(repeated.image_download.downloaded.length, 0, '下载不能覆盖已有文件');
  assert.equal(repeated.image_download.errors.length, 1);
  // 中文说明：从隔离 Chromium 生成真实编码的透明长PNG、大尺寸JPEG和WebP，避免把网站标题或URL后缀当作文件格式。
  const imagePort = Number((await fs.readFile(path.join(temporary, 'data/profiles/test/DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const imagePages = await (await fetch(`http://127.0.0.1:${imagePort}/json/list`)).json();
  const generator = await Cdp.connect(imagePages.find(page => page.id === beforeImages.active_id).webSocketDebuggerUrl);
  let formats;
  try {
    const generated = await generator.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const images = [];
      for (const [type, width, height] of [['image/png', 64, 4096], ['image/jpeg', 4096, 2160], ['image/webp', 320, 240]]) {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#e63c32'; context.fillRect(0, 0, width / 2, height);
        const blob = await canvas.convertToBlob({ type });
        const data = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of data) binary += String.fromCharCode(byte);
        images.push({ type: blob.type, width, height, base64: btoa(binary) });
      }
      return images;
    })()` });
    assert.equal(generated.exceptionDetails, undefined);
    formats = generated.result.value;
  } finally { generator.close(); }
  assert.deepEqual(formats.map(image => image.type), ['image/png', 'image/jpeg', 'image/webp']);
  // 中文说明：这两个小型真实文件来自W3C公开格式测试页 https://www.w3.org/People/mimasa/test/imgformat/ ，随测试离线保存，不代表小红书提供PNG/JPEG。
  for (const [name, type] of [['w3c-home.png', 'image/png'], ['w3c-home.jpg', 'image/jpeg']]) {
    const data = await fs.readFile(new URL('./fixtures/' + name, import.meta.url));
    formats.push({ type, width: 72, height: 48, base64: data.toString('base64') });
  }
  for (const [index, image] of formats.entries()) imageFixtures.set(`/format-${index}`, { type: image.type, data: Buffer.from(image.base64, 'base64') });
  imageRecord.result.images = formats.map((image, index) => ({ index: index + 1, url: fixtureUrl + `format-${index}`, width: image.width, height: image.height }));
  await fs.writeFile(snapshotFile, JSON.stringify(imageRecord));
  const encoded = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: path.join(temporary, 'encoded-images') })).json();
  assert.equal(encoded.image_download.errors.length, 0);
  assert.equal(encoded.image_download.downloaded.length, 5);
  for (const [index, file] of encoded.image_download.downloaded.entries()) {
    const original = formats[index];
    assert.equal(file.content_type, original.type);
    assert.equal(path.extname(file.file), ['.png', '.jpg', '.webp', '.png', '.jpg'][index]);
    assert.deepEqual([file.actual_width, file.actual_height], [original.width, original.height]);
    assert.equal(file.decoded, true); assert.equal(file.manifest_dimensions_match, true);
    assert.deepEqual(await fs.readFile(file.file), imageFixtures.get(`/format-${index}`).data, '保存文件应保持编码字节不变');
    assert.equal((await fs.stat(file.file)).mode & 0o777, 0o600);
  }
  imageRecord.result.images = [{ index: 1, url: fixtureUrl + 'interrupted.png' }, { index: 2, url: fixtureUrl + 'format-0', width: 64, height: 4096 }, { index: 3, url: fixtureUrl + 'limited.png' }];
  await fs.writeFile(snapshotFile, JSON.stringify(imageRecord));
  const interruptedDirectory = path.join(temporary, 'interrupted-images');
  const interrupted = await (await api('/api/read', { url: fixtureUrl + 'changing', snapshot_id: changingRead.snapshot.id, download_images: interruptedDirectory })).json();
  assert.deepEqual(interrupted.image_download.downloaded.map(file => file.index), [2], '一个图片断流或限流不应阻止后续图片');
  assert.deepEqual(await fs.readdir(interruptedDirectory), ['02.png'], '断流不应留下不完整的图片文件');
  const [networkError, limitedError] = interrupted.image_download.errors;
  assert.equal(networkError.index, 1);
  assert.equal(networkError.code, 'UND_ERR_SOCKET');
  assert.equal(networkError.recovery.next_action, 'check_network_then_retry');
  assert.equal(limitedError.code, 'http_429'); assert.equal(limitedError.status, 429);
  assert.equal(limitedError.recovery.retry_after_seconds, 7);
  const firstWindow = await (await api('/api/read', { url: fixtureUrl + 'long', max_chars: 200 })).json();
  assert.equal(firstWindow.content.length, 200);
  assert.equal(firstWindow.content_window.has_more, true);
  const secondWindow = await (await api('/api/read', { url: fixtureUrl + 'long', max_chars: 200, offset: firstWindow.content_window.next_offset })).json();
  assert.equal(secondWindow.content_window.offset, firstWindow.content_window.next_offset);
  assert.equal(secondWindow.content_window.returned_chars, secondWindow.content.length);
  const fullUnicode = await (await api('/api/read', { url: fixtureUrl + 'unicode', max_chars: 5000 })).json();
  let unicodeOffset = 0;
  let unicodeAssembled = '';
  do {
    const part = await (await api('/api/read', { url: fixtureUrl + 'unicode', max_chars: 200, offset: unicodeOffset })).json();
    assert.equal(part.content_window.offset, unicodeOffset);
    unicodeAssembled += part.content;
    const next = part.content_window.next_offset;
    assert.ok(next === null || next > unicodeOffset, '续读必须向前推进');
    unicodeOffset = next;
  } while (unicodeOffset !== null);
  assert.equal(unicodeAssembled, fullUnicode.content, '浏览器分段拼接应保留全部文本与 emoji');
  const endWindow = await (await api('/api/read', { url: fixtureUrl + 'unicode', offset: fullUnicode.content.length + 10 })).json();
  assert.equal(endWindow.content, '');
  assert.equal(endWindow.content_window.offset, fullUnicode.content.length);
  assert.equal(endWindow.content_window.requested_offset, fullUnicode.content.length + 10);
  assert.equal(endWindow.content_window.next_offset, null);
  for (const offset of [-1, 0.5, 'bad', null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await api('/api/read', { url: fixtureUrl + 'unicode', offset });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /offset 必须是非负安全整数/);
  }
  const concurrentReads = await Promise.all([
    api('/api/read', { url: fixtureUrl + 'slow' }),
    api('/api/read', { url: fixtureUrl + 'slow' })
  ]);
  assert.deepEqual(concurrentReads.map(response => response.status), [200, 200], '多个 Agent 读取应由服务端队列串行处理');
  const compactRead = await (await api('/api/read', { url: fixtureUrl + 'long', compact: true, max_chars: 200 })).json();
  assert.equal(compactRead.response_mode, 'compact');
  assert.equal(compactRead.subtitle, undefined);
  assert.equal(compactRead.content.length, 200);
  const compactNext = await (await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: compactRead.snapshot.id, offset: compactRead.content_window.next_offset, max_chars: 200 })).json();
  assert.equal(compactNext.response_mode, 'compact', '快照续读省略compact时应沿用原模式');
  assert.equal(compactNext.subtitle, undefined);
  const leanResponse = await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: compactRead.snapshot.id, offset: compactRead.content_window.next_offset, max_chars: 200, lean: true });
  assert.equal(leanResponse.status, 200);
  const leanNext = await leanResponse.json();
  assert.equal(leanNext.response_mode, 'lean');
  assert.equal(leanNext.snapshot.id, compactRead.snapshot.id);
  assert.equal(leanNext.metadata_ref.snapshot_id, compactRead.snapshot.id);
  assert.equal(leanNext.content, compactNext.content);
  assert.deepEqual(leanNext.content_window, compactNext.content_window);
  assert.deepEqual(leanNext.warnings, compactNext.warnings);
  assert.deepEqual(leanNext.missing_fields, compactNext.missing_fields);
  assert.equal(leanNext.subtitle, undefined);
  assert.equal(leanNext.provenance, undefined);
  assert.equal(leanNext.title, undefined);
  const restoredNext = await (await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: compactRead.snapshot.id, offset: compactRead.content_window.next_offset, max_chars: 200 })).json();
  assert.deepEqual(restoredNext, compactNext, '精简读取不能持久改变旧格式');
  for (const extra of [{ lean: 'true' }, { lean: true, snapshot_id: null }, { lean: true, find: '正文' }, { lean: true, export_directory: temporary }, { lean: true, download_images: temporary }, { lean: true, compact: false }]) {
    const rejected = await api('/api/read', { url: fixtureUrl + 'long', snapshot_id: compactRead.snapshot.id, ...extra });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /lean/);
  }
  const invalidVideoOptions = await api('/api/read', { url: fixtureUrl + 'long', pages: '13-14' });
  assert.equal(invalidVideoOptions.status, 400, '其他网站不能静默忽略B站参数');
  const invalidCompact = await api('/api/read', { url: fixtureUrl + 'long', compact: 'true' });
  assert.equal(invalidCompact.status, 400);
  for (const extra of [{ url: fixtureUrl }, { list_tracks: 'true' }, { snapshot_id: compactRead.snapshot.id }, { subtitle_language: 'en-US' }, { compact: true }, { offset: 200 }, { format: 'markdown' }]) {
    const rejected = await api('/api/read', { url: 'https://www.bilibili.com/video/BVfixture', list_tracks: true, ...extra });
    assert.equal(rejected.status, 400, '清单参数错误必须在访问真实平台前拒绝');
    assert.match((await rejected.json()).error, /list_tracks/);
  }
  const burstReads = await Promise.all(Array.from({ length: 10 }, () => api('/api/read', { url: fixtureUrl + 'queue' })));
  const rejectedReads = burstReads.filter(response => response.status === 429);
  assert.ok(rejectedReads.length > 0, '读取队列达到上限时应返回 429');
  assert.ok(rejectedReads.every(response => response.headers.get('retry-after') === '3'), '队列满时应返回 Retry-After');
  const rejected = await rejectedReads[0].json();
  assert.equal(rejected.retry_after, 3, '队列满响应应返回重试秒数');
  assert.equal(rejected.code, 'browser_adapter_busy');
  assert.equal(rejected.recovery.retryable, true);
  assert.equal(rejected.recovery.retry_after_seconds, 3);
  const queueStatus = await (await api('/api/status')).json();
  assert.ok(queueStatus.queue_diagnostics.rejected_requests > 0, '状态应累计报告队列拒绝次数');
  assert.equal(queueStatus.in_flight, 0, '所有请求完成后队列应清空');
  assert.equal((await api('/api/navigate', { url: 'example.com' })).status, 200, '不带协议的域名应自动补全 HTTPS');
  assert.equal((await api('/api/mode', { automation: true })).status, 404, '旧模式开关接口应已移除');
  assert.equal((await api('/api/navigate', { url: fixtureUrl + 'set' })).status, 200);
  await delay(700);
  await api('/api/viewport', { width: 800, height: 1000 });
  const status = await (await api('/api/status')).json();
  assert.equal(Object.hasOwn(status, 'automation'), false);
  assert.deepEqual(status.viewport, { width: 800, height: 1000 });
  const initialScroll = await (await api('/api/scroll', { deltaY: 0 })).json();
  assert.ok(initialScroll.scroll.maxTop > 0, '长页面应返回可滚动范围');
  assert.equal(initialScroll.scroll.top, 0, '页面初始位置应在顶部');
  const frame = Buffer.from(await (await api('/api/frame')).arrayBuffer());
  assert.equal(frame.readUInt16BE(), 0xffd8);
  await api('/api/input', { type: 'mouse', x: 80, y: 40 });
  await api('/api/input', { type: 'mouse', x: 80, y: 40, up: true });
  await api('/api/input', { type: 'text', text: '手机中文输入' });
  const port = Number((await fs.readFile(path.join(temporary, 'data/profiles/test/DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  pageCdp = await Cdp.connect(pages.find(page => page.url === fixtureUrl + 'set').webSocketDebuggerUrl);
  const input = await pageCdp.send('Runtime.evaluate', { expression: 'document.getElementById("text").value', returnByValue: true });
  assert.equal(input.result.value, '手机中文输入');
  await api('/api/navigate', { url: nestedUrl });
  await delay(300);
  const nestedInitial = await (await api('/api/scroll', { deltaY: 0 })).json();
  assert.ok(nestedInitial.scroll.maxTop > 0, '内部滚动容器应返回可滚动范围');
  await api('/api/scroll', { deltaY: 600 });
  const nestedTop = await pageCdp.send('Runtime.evaluate', { expression: 'document.getElementById("nested").scrollTop', returnByValue: true });
  assert.ok(nestedTop.result.value > 0, '侧栏滚动接口应推动内部滚动容器');
  await api('/api/navigate', { url: blockedUrl });
  await delay(300);
  const wheelBefore = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  const wheelResponse = await api('/api/input', { type: 'wheel', x: 400, y: 400, deltaY: 600 });
  assert.equal(wheelResponse.status, 200, '滚轮接口应返回成功');
  const wheelAfter = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(wheelAfter.result.value > wheelBefore.result.value, '页面拦截 CDP 滚轮时仍应由服务端兜底滚动');
  await api('/api/navigate', { url: horizontalUrl });
  await delay(300);
  const horizontalInitial = await (await api('/api/scroll', { deltaX: 0, deltaY: 0 })).json();
  assert.ok(horizontalInitial.scroll.maxLeft > 0, '横向页面应返回可滚动范围');
  const horizontalWheel = await api('/api/input', { type: 'wheel', x: 400, y: 400, deltaX: 700, deltaY: 0 });
  assert.equal(horizontalWheel.status, 200, '横向滚轮接口应返回成功');
  const horizontalTop = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollX', returnByValue: true });
  assert.ok(horizontalTop.result.value > 0, '横向滚轮应推动远程网页');
  await api('/api/navigate', { url: fixtureUrl + 'set' });
  await delay(300);
  // 在真实 Chromium 中以手机 User-Agent 和尺寸打开工作台，验证脚本、画面和触屏坐标映射。
  const { targetId: workbenchId } = await pageCdp.send('Target.createTarget', { url: 'about:blank', background: true });
  const workbenchPages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  workbenchCdp = await Cdp.connect(workbenchPages.find(item => item.id === workbenchId).webSocketDebuggerUrl);
  await workbenchCdp.send('Network.enable');
  await workbenchCdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50', acceptLanguage: 'zh-CN,zh;q=0.9' });
  await workbenchCdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await workbenchCdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await workbenchCdp.send('Page.navigate', { url: state.base_url + '/#token=' + state.token });
  let rendered;
  for (let i = 0; i < 50; i++) {
    rendered = await workbenchCdp.send('Runtime.evaluate', { expression: `document.getElementById('profile')?.textContent.includes('test') && document.getElementById('screen').getContext('2d').getImageData(0,0,1,1).data[3] === 255`, returnByValue: true });
    if (rendered.result.value) break;
    await delay(100);
  }
  assert.equal(rendered.result.value, true, '手机工作台未取得真实画面');
  const modeButton = await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('mode') === null", returnByValue: true });
  assert.equal(modeButton.result.value, true, '工作台不应保留授权开关');
  const orientationButton = await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('toggle-orientation')?.textContent", returnByValue: true });
  assert.equal(orientationButton.result.value, '切换横屏');
  const compactControls = await workbenchCdp.send('Runtime.evaluate', { expression: "getComputedStyle(document.getElementById('quick-sites')).display !== 'none' && getComputedStyle(document.getElementById('page-scroll')).display !== 'none'", returnByValue: true });
  assert.equal(compactControls.result.value, true, '手机端应显示登录网站按钮和侧栏滚动导航');
  await api('/api/navigate', { url: horizontalUrl });
  await delay(300);
  const horizontalTouchStart = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const r=document.getElementById('screen').getBoundingClientRect(); return {x:r.left+r.width*.75,y:r.top+r.height*.5}; })()`, returnByValue: true });
  const horizontalTouchEnd = { x: horizontalTouchStart.result.value.x - 220, y: horizontalTouchStart.result.value.y };
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [horizontalTouchStart.result.value] });
  await delay(120);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [horizontalTouchEnd] });
  await delay(120);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(200);
  const horizontalTouchScroll = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollX', returnByValue: true });
  assert.ok(horizontalTouchScroll.result.value > 0, '横向滑动画面应推动远程网页');
  await api('/api/navigate', { url: fixtureUrl + 'set' });
  await delay(300);
  const deviceStatus = await (await api('/api/status', undefined, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile' })).json();
  assert.equal(deviceStatus.device_type, 'mobile');
  const desktopWechatStatus = await (await api('/api/status', undefined, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 MicroMessenger/8.0.50' })).json();
  assert.equal(desktopWechatStatus.device_type, 'desktop');
  await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('toggle-orientation').click()" });
  await delay(400);
  assert.deepEqual((await (await api('/api/status')).json()).viewport, { width: 844, height: 390 });
  const rotated = await workbenchCdp.send('Runtime.evaluate', { expression: "document.body.classList.contains('mobile-landscape') && getComputedStyle(document.getElementById('app-shell')).transform !== 'none'", returnByValue: true });
  assert.equal(rotated.result.value, true, '手机横屏应旋转整个工作台');
  const landscapePoint = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const canvas=document.getElementById('screen'); const rect=canvas.getBoundingClientRect(); return {x:rect.right-40*rect.width/canvas.height,y:rect.top+80*rect.height/canvas.width}; })()`, returnByValue: true });
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [landscapePoint.result.value] });
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(200);
  await api('/api/input', { type: 'text', text: '横屏坐标' });
  const landscapeInput = await pageCdp.send('Runtime.evaluate', { expression: 'document.getElementById("text").value', returnByValue: true });
  assert.match(landscapeInput.result.value, /横屏坐标/, '横屏旋转后的触摸坐标未映射到远程输入框');
  await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('toggle-orientation').click()" });
  await delay(400);
  assert.deepEqual((await (await api('/api/status')).json()).viewport, { width: 390, height: 844 });
  await api('/api/scroll', { deltaY: -5000 });
  await delay(150);
  const point = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const canvas=document.getElementById('screen'); canvas.scrollIntoView({block:'start'}); const rect=canvas.getBoundingClientRect(); return {x:rect.left+80*rect.width/canvas.width,y:rect.top+40*rect.height/canvas.height}; })()`, returnByValue: true });
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point.result.value] });
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(300);
  await workbenchCdp.send('Runtime.evaluate', { expression: `window.__testSubmit=false;document.getElementById('text-form').addEventListener('submit',()=>window.__testSubmit=true,{once:true});document.getElementById('text').value='前端提交';document.getElementById('text-form').querySelector('button[type="submit"],button').click()` });
  let submitted;
  for (let i = 0; i < 30; i++) {
    submitted = await pageCdp.send('Runtime.evaluate', { expression: 'document.getElementById("text").value', returnByValue: true });
    if (submitted.result.value.includes('前端提交')) break;
    await delay(100);
  }
  const submitEvent = await workbenchCdp.send('Runtime.evaluate', { expression: 'window.__testSubmit', returnByValue: true });
  assert.equal(submitEvent.result.value, true, '工作台表单提交事件未触发');
  assert.match(submitted.result.value, /前端提交/, `前端输入未送达，工作台提示：${(await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('notice').textContent", returnByValue: true })).result.value}`);
  const swipeStart = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const c=document.getElementById('screen'),r=c.getBoundingClientRect(); return {x:r.left+r.width*.5,y:r.top+r.height*.62}; })()`, returnByValue: true });
  const swipeEnd = { x: swipeStart.result.value.x, y: swipeStart.result.value.y - 260 };
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipeStart.result.value] });
  await delay(120);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [swipeEnd] });
  await delay(120);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(200);
  const swipeScrollY = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(swipeScrollY.result.value > 0, '滑动画面应推动远程网页');
  await api('/api/scroll', { deltaY: 600 });
  await delay(150);
  const remoteScrollY = await pageCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(remoteScrollY.result.value > 0, '远程滚动接口应推动远程网页');
  await api('/api/scroll', { deltaY: -5000 });
  await delay(150);
  const outerMetrics = await workbenchCdp.send('Runtime.evaluate', { expression: '({top:window.scrollY,maxTop:Math.max(0,(document.scrollingElement||document.documentElement).scrollHeight-(document.scrollingElement||document.documentElement).clientHeight)})', returnByValue: true });
  assert.ok(outerMetrics.result.value.maxTop > 0, '手机工作台应有外层网页滚动范围');
  const buttonBefore = await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  await workbenchCdp.send('Runtime.evaluate', { expression: "document.getElementById('scroll-down').click()" });
  await delay(250);
  const buttonAfter = await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(buttonAfter.result.value > buttonBefore.result.value, '手机向下按钮应推动微信工作台网页');
  await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
  await delay(100);
  const track = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const r=document.getElementById('scroll-track').getBoundingClientRect(); return {x:r.left+r.width/2,y1:r.top+8,y2:r.bottom-8}; })()`, returnByValue: true });
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: track.result.value.x, y: track.result.value.y1 }] });
  await delay(100);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: track.result.value.x, y: track.result.value.y2 }] });
  await delay(100);
  await workbenchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(200);
  const trackScrollY = await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(trackScrollY.result.value > 0, '侧边原生滚动条拖动应推动微信工作台网页');
  await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
  const wheelPoint = await workbenchCdp.send('Runtime.evaluate', { expression: `(() => { const r=document.getElementById('scroll-track').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`, returnByValue: true });
  await workbenchCdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPoint.result.value.x, y: wheelPoint.result.value.y, deltaX: 0, deltaY: 300 });
  await delay(150);
  const wheelOuterScrollY = await workbenchCdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
  assert.ok(wheelOuterScrollY.result.value > 0, '侧栏滚轮应推动微信工作台网页');
  workbenchCdp.close(); workbenchCdp = null;
  const browserVersion = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserControl = await Cdp.connect(browserVersion.webSocketDebuggerUrl);
  await browserControl.send('Target.closeTarget', { targetId: workbenchId });
  browserControl.close();
  pageCdp.close(); pageCdp = null;
  await delay(200);
  const afterTargetClose = await (await api('/api/status')).json();
  assert.equal(afterTargetClose.tabs.some(tab => tab.id === workbenchId), false, '关闭标签页后服务应清理失效连接');
  // 模拟空闲 Chromium 崩溃；服务应在同一 Profile 中重建浏览器并保留服务令牌。
  // 先正常重启验证 Cookie 已落盘，再测试崩溃恢复；页面可见和固定等待几秒都不足以证明磁盘提交完成。
  const cookieBeforeCrash = await (await api('/api/read', { url: fixtureUrl + 'read' })).json();
  assert.match(cookieBeforeCrash.content, /hub_fixture=persisted/);
  await stop();
  await start();
  const committedCookie = await (await api('/api/read', { url: fixtureUrl + 'read' })).json();
  assert.match(committedCookie.content, /hub_fixture=persisted/, '崩溃夹具的 Cookie 必须先通过正常重启确认持久化');
  const crashedBrowserPid = state.browser_pid;
  process.kill(crashedBrowserPid, 'SIGKILL');
  let recoveredState;
  let recoveredStatus;
  for (let i = 0; i < 100; i++) {
    recoveredState = await fs.readFile(path.join(temporary, 'session.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (recoveredState?.browser_pid && recoveredState.browser_pid !== crashedBrowserPid) {
      recoveredStatus = await (await api('/api/status')).json().catch(() => null);
      if (recoveredStatus && !recoveredStatus.browser_recovering) break;
    }
    await delay(100);
  }
  assert.ok(recoveredState?.browser_pid && recoveredState.browser_pid !== crashedBrowserPid, '空闲浏览器崩溃后未重建新进程');
  assert.equal(recoveredStatus?.browser_recovering, false, '浏览器恢复状态未结束');
  assert.equal(recoveredStatus?.browser_restart_count, 1, '浏览器恢复次数未记录');
  assert.equal(recoveredState.token, state.token, '浏览器恢复不应更换服务令牌');
  state = recoveredState;
  const firstRead = await (await api('/api/read', { url: fixtureUrl + 'read' })).json();
  assert.match(firstRead.content, /hub_fixture=persisted/);
  await stop();
  await start();
  const persistedSnapshot = await (await api('/api/read', { url: fixtureUrl + 'structured', snapshot_id: structuredRead.snapshot.id })).json();
  assert.equal(persistedSnapshot.content, structuredRead.content, '服务重启后仍应能读取有效正文快照');
  assert.equal(persistedSnapshot.content_format, 'markdown');
  const secondRead = await (await api('/api/read', { url: fixtureUrl + 'read' })).json();
  assert.match(secondRead.content, /hub_fixture=persisted/);
  console.log('通过：Chromium 启动渲染与零意外重启、正文 Markdown 与快照续读、按编号图片下载、队列与鉴权、手机画面与触屏输入、空闲崩溃恢复、Cookie 与快照跨重启持久化。');
} catch (error) {
  console.error(`集成测试环境：Node ${process.version}，${process.platform}/${process.arch}，npm 启动 Node=${process.env.npm_node_execpath || '未通过 npm'}，cwd=${process.cwd()}`);
  console.error('browser-hub 集成测试服务日志：\n' + logs.replace(/token=[\w-]+/g, 'token=***').replace(/"token"\s*:\s*"[^"]*"/g, '"token":"***"'));
  throw error;
} finally {
  workbenchCdp?.close();
  pageCdp?.close();
  await stop();
  fixture.close(); fixture.closeAllConnections();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
