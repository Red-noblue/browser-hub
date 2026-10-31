// 中文说明：模拟调试端口可用但渲染失败的浏览器，验证服务不会误报启动成功，并回收进程和 Profile 锁。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MODULE_ROOT } from '../src/paths.mjs';

const require = createRequire(path.join(MODULE_ROOT, '__browser_startup__.cjs'));
const { WebSocketServer } = require('ws');
const testRoot = fileURLToPath(new URL('../run/test-tmp/', import.meta.url));
await fs.mkdir(testRoot, { recursive: true });
const temporary = await fs.mkdtemp(path.join(testRoot, 'browser-startup-'));
const backend = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify([{ type: 'page', id: 'page', webSocketDebuggerUrl: `${websocket}/page` }]));
});
const sockets = new WebSocketServer({ server: backend });
let screenshotAttempts = 0;
sockets.on('connection', socket => socket.on('message', payload => {
  const message = JSON.parse(String(payload));
  const result = message.method === 'Runtime.evaluate' ? { result: { value: true } }
    : message.method === 'Browser.getVersion' ? { userAgent: 'StartupFixture', product: 'Fixture' } : {};
  if (message.method === 'Page.captureScreenshot') {
    screenshotAttempts += 1;
    socket.send(JSON.stringify({ id: message.id, error: { message: '模拟渲染进程不可用' } }));
  } else socket.send(JSON.stringify({ id: message.id, result }));
}));
backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
const websocket = `ws://127.0.0.1:${backend.address().port}`;
const executable = path.join(temporary, 'fake-browser');
const childScript = path.join(temporary, 'fake-browser.cjs');
await fs.writeFile(childScript, `// 中文说明：故障注入浏览器，只发布调试端口并模拟拒绝正常退出。\nrequire('node:fs').writeFileSync(process.env.BROWSER_HUB_FIXTURE_PID, String(process.pid));\nprocess.on('SIGTERM', () => {});\nconsole.error('icudtl.dat not found in bundle');\nconsole.error('DevTools listening on ' + process.env.BROWSER_HUB_FIXTURE_WS + '/browser');\nsetInterval(() => {}, 1000);\n`);
await fs.writeFile(executable, '#!/usr/bin/env bash\n# 中文说明：复用测试 Node，不读取真实浏览器资料。\nexec "$BROWSER_HUB_FIXTURE_NODE" "$BROWSER_HUB_FIXTURE_SCRIPT"\n', { mode: 0o700 });
const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const child = spawn(process.execPath, [entry, 'serve', '--port', '0', '--profile', 'startup-test', '--browser', executable], {
  env: { ...process.env, BROWSER_HUB_RUN_ROOT: temporary, BROWSER_HUB_FIXTURE_WS: websocket,
    BROWSER_HUB_FIXTURE_NODE: process.execPath, BROWSER_HUB_FIXTURE_SCRIPT: childScript, BROWSER_HUB_FIXTURE_PID: path.join(temporary, 'browser.pid') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', value => { output += value; });
child.stderr.on('data', value => { output += value; });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 10000);
try {
  const [code] = await once(child, 'exit');
  assert.equal(timedOut, false, '渲染失败应主动退出');
  assert.notEqual(code, 0);
  assert.equal(screenshotAttempts, 1, '启动成功前必须实际检查页面画面');
  assert.match(output, /浏览器页面初始化失败/);
  assert.match(output, /模拟渲染进程不可用/);
  if (process.platform === 'darwin') assert.match(output, /文件访问权限/);
  assert.doesNotMatch(output, /浏览器工作台：/);
  assert.equal(await fs.access(path.join(temporary, 'session.json')).then(() => true, () => false), false);
  assert.deepEqual(await fs.readdir(path.join(temporary, 'profile-locks')), []);
  const pid = Number(await fs.readFile(path.join(temporary, 'browser.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '初始化失败后不应残留浏览器进程');
  console.log('通过：调试端口可用但渲染失败时，服务拒绝就绪并清理自建进程和 Profile 锁。');
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(); backend.close(); backend.closeAllConnections();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
