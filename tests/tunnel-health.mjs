// 中文说明：验证公网入口健康检查能区分可达、Cloudflare 530 和连接失败，避免把失效链接交给手机。
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { probePublicUrl } from '../src/tunnel.mjs';

let healthStatus = 200;
const server = http.createServer((request, response) => {
  response.statusCode = healthStatus;
  response.end('health');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
try {
  assert.equal((await probePublicUrl(`http://127.0.0.1:${port}/ok`, 1000)).ok, true);
  healthStatus = 530;
  const unavailable = await probePublicUrl(`http://127.0.0.1:${port}`, 1000);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 530);
} finally {
  server.close();
  await once(server, 'close');
}
const closed = await probePublicUrl(`http://127.0.0.1:${port}/closed`, 500);
assert.equal(closed.ok, false);
console.log('通过：隧道健康检查可区分成功、HTTP 530 和连接失败。');
