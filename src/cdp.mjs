// 中文说明：最小 CDP 客户端，只依赖共享 ws；不引入 Playwright/Puppeteer 和额外浏览器副本。
import path from 'node:path';
import { createRequire } from 'node:module';
import { MODULE_ROOT } from './paths.mjs';
const require = createRequire(path.join(MODULE_ROOT, '__browser_hub__.cjs'));
let WebSocket;
try { WebSocket = require('ws'); }
catch { throw new Error('缺少共享 ws 依赖，请先执行 tools/browser-hub/bin/install-deps.sh'); }
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    socket.on('message', buffer => {
      const message = JSON.parse(buffer.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
    socket.on('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('浏览器连接已关闭'));
      }
      this.pending.clear();
    });
    socket.on('error', () => {});
  }
  // 中文说明：服务端在标签页崩溃或被外部关闭后，用此状态丢弃旧连接并重新连接。
  isOpen() { return !this.closed && this.socket.readyState === 1; }
  static async connect(url) {
    const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return new Cdp(socket);
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`浏览器调用超时：${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  close() { if (this.socket.readyState < 2) this.socket.close(); }
}
