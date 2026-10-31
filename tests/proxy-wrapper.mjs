// 中文说明：验证 browser-hub 包装器直接调用项目 Node；代理分支仅在已有代理运行时检查环境注入，不启动或停止用户代理。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const wrapper = path.join(root, 'tools/browser-hub/bin/browser-hub');
const testRoot = path.join(root, 'tools/browser-hub/run/test-tmp');
await fs.mkdir(testRoot, { recursive: true });
const temporary = await fs.mkdtemp(path.join(testRoot, 'proxy-wrapper-'));
const fakeNode = path.join(temporary, 'node');
const capture = path.join(temporary, 'capture.json');
await fs.writeFile(fakeNode, `#!/usr/bin/env node
// 中文说明：只记录包装器传入的 CLI 路径和代理环境，不启动浏览器。
import fs from 'node:fs';
fs.writeFileSync(process.env.BROWSER_HUB_WRAPPER_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: { http_proxy: process.env.http_proxy || null, https_proxy: process.env.https_proxy || null, tunnel: process.env.BROWSER_HUB_TUNNEL_PROXY || null } }));
`, { mode: 0o700 });

try {
  await run('bash', ['-n', wrapper]);
  const direct = await run(wrapper, ['--help'], { env: { ...process.env, BROWSER_HUB_NODE_BIN: fakeNode, BROWSER_HUB_WRAPPER_CAPTURE: capture } });
  const directCall = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(path.normalize(directCall.argv[0]), path.join(root, 'tools/browser-hub/src/cli.mjs'));
  assert.deepEqual(directCall.argv.slice(1), ['--help']);
  assert.equal(directCall.env.tunnel, null);
  assert.equal(direct.stderr, '');

  const proxyState = await run('bash', ['-c', 'source "$1/tools/proxy-tunnel/bin/common.sh"; if is_running; then printf running; else printf stopped; fi', 'browser-hub-proxy-check', root]);
  if (proxyState.stdout.trim() === 'running') {
    const proxy = await run(wrapper, ['--proxy', '--help'], { env: { ...process.env, BROWSER_HUB_NODE_BIN: fakeNode, BROWSER_HUB_WRAPPER_CAPTURE: capture } });
    const proxyCall = JSON.parse(await fs.readFile(capture, 'utf8'));
    assert.equal(path.normalize(proxyCall.argv[0]), path.join(root, 'tools/browser-hub/src/cli.mjs'));
    assert.deepEqual(proxyCall.argv.slice(1), ['--help']);
    assert.equal(proxyCall.env.tunnel, '1');
    assert.match(proxyCall.env.http_proxy || '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(proxyCall.env.https_proxy || '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(proxy.stderr, '');
    console.log('通过：browser-hub 直接入口和已有代理入口均只调用一次 CLI，代理环境在当前进程注入。');
  } else {
    console.log('通过：browser-hub 直接入口只调用一次 CLI；未检测到已有 proxy-tunnel，跳过不启动代理的代理分支检查。');
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
