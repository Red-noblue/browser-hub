// 中文说明：统一回收 Browser Hub 自己启动的子进程，先优雅退出，超时后强制终止并确认已经退出。
import { once } from 'node:events';

function processAlive(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function signalChild(child, signal) {
  if (!processAlive(child)) return;
  try {
    process.kill(child.__browserHubDetached ? -child.pid : child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* 子进程可能刚刚退出 */ }
  }
}

export async function stopChild(child, { graceMs = 3000, confirmMs = 1000 } = {}) {
  if (!child || !processAlive(child)) return { stopped: true, forced: false, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  const exited = once(child, 'exit').catch(() => {});
  signalChild(child, 'SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, graceMs))]);
  let forced = false;
  if (processAlive(child)) {
    forced = true;
    const killed = once(child, 'exit').catch(() => {});
    signalChild(child, 'SIGKILL');
    await Promise.race([killed, new Promise(resolve => setTimeout(resolve, confirmMs))]);
  }
  return { stopped: !processAlive(child), forced, exitCode: child.exitCode ?? null, signal: child.signalCode ?? null };
}

export { processAlive };
