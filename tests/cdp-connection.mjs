// 中文说明：验证 CDP 连接关闭时能标记失效并拒绝未完成请求，便于服务端回收和重建标签页连接。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Cdp } from '../src/cdp.mjs';

class FakeSocket extends EventEmitter {
  readyState = 1;

  send(payload, callback) {
    if (this.readyState !== 1) {
      callback?.(new Error('socket closed'));
      return;
    }
    const message = JSON.parse(payload);
    if (message.method !== 'Delayed') {
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify({ id: message.id, result: { ok: true } })));
        callback?.();
      });
    } else callback?.();
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close');
  }
}

const socket = new FakeSocket();
const client = new Cdp(socket);
assert.equal(client.isOpen(), true);
assert.deepEqual(await client.send('Health'), { ok: true });
const pending = client.send('Delayed');
socket.close();
await assert.rejects(pending, /浏览器连接已关闭/);
assert.equal(client.isOpen(), false);
client.close();
console.log('browser-hub CDP connection test passed');
