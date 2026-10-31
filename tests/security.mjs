// 中文说明：验证 Browser Hub 使用的网络边界和统一子进程回收；不启动真实浏览器、不读取登录 Profile。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { checkTarget } from '../../agent-search/shared/network-policy.mjs';
import { stopChild } from '../src/process.mjs';

await assert.rejects(checkTarget('http://127.0.0.1:8791/', { mode: 'public', resolveDns: false }), error => error.code === 'target_blocked_private');
assert.equal((await checkTarget('http://127.0.0.1:8791/', { mode: 'local' })).host, '127.0.0.1');
await assert.rejects(checkTarget('https://user:password@example.com/', { mode: 'public', resolveDns: false }), error => error.code === 'target_credentials_forbidden');

const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
const result = await stopChild(child, { graceMs: 20, confirmMs: 1000 });
assert.equal(result.stopped, true, '子进程必须在停止流程结束后确认退出');
console.log('browser-hub security policy and process cleanup tests passed');
