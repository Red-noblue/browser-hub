// 中文说明：使用带令牌的本地接口获取画面、转发键鼠；令牌只放在浏览器会话中，不进入 URL 请求日志。
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('browser-hub-token');
if (fragment.has('token')) { sessionStorage.setItem('browser-hub-token', token); history.replaceState(null, '', '/'); }
const element = id => document.getElementById(id);
const screen = element('screen');
const context = screen.getContext('2d');
let activeId;
let inputQueue = Promise.resolve();
let mouseDown = false;
let touch;
let mobileViewportAdjusted = false;
let mobileLandscape = false;
let frameInFlight = false;
let scrollPosition = 0;
let scrollMetricsUpdating = false;
const touchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const FRAME_INTERVAL = 80;
const notice = value => { element('notice').textContent = value; };
// 中文说明：登录状态由服务端根据活动标签页的实际页面判定；前端不读取 Cookie，也不把页面正文写入状态栏。
function updateLoginStatus(login) {
  const status = login || { state: 'unknown', label: '尚未确认登录状态' };
  const node = element('login-status');
  node.textContent = `登录状态：${status.label || status.state || '未知'}`;
  node.dataset.state = status.state || 'unknown';
  node.title = status.site ? `来源：${status.site}` : '';
}
function pageScrollMetrics() {
  const root = document.scrollingElement || document.documentElement;
  const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
  return { top: Math.max(0, root.scrollTop || window.scrollY || 0), maxTop };
}
function updatePageScrollBar() {
  const metrics = pageScrollMetrics();
  if (scrollMetricsUpdating) return;
  scrollPosition = Math.max(0, Math.min(metrics.maxTop, metrics.top));
  const track = element('scroll-track');
  scrollMetricsUpdating = true;
  track.max = String(Math.max(1, Math.round(metrics.maxTop)));
  track.value = String(Math.round(scrollPosition));
  track.setAttribute('aria-valuemax', String(Math.round(metrics.maxTop)));
  track.setAttribute('aria-valuenow', String(Math.round(scrollPosition)));
  scrollMetricsUpdating = false;
}
async function api(endpoint, body, binary = false) {
  const response = await fetch('/api/' + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token || ''}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error((await response.json()).error || '连接失败');
  return binary ? response.blob() : response.json();
}
function input(body) {
  inputQueue = inputQueue.then(() => api('input', body)).catch(error => notice(error.message));
  return inputQueue;
}
// 中文说明：微博根首页在无头浏览器中可能只返回空白画面；手动输入域名时直接进入登录入口。
function normalizeNavigationUrl(value) {
  const parsed = new URL(value);
  if (/^(?:www\.)?weibo\.com$/i.test(parsed.hostname) && (parsed.pathname === '/' || !parsed.pathname)) parsed.pathname = '/newlogin';
  return parsed.href;
}
async function refreshStatus() {
  try {
    const status = await api('status');
    document.body.classList.toggle('mobile-mode', status.device_type === 'mobile');
    // 中文说明：手机首次打开固定竖屏；方向只由按钮改变，不读取陀螺仪或浏览器方向。
    if (!mobileViewportAdjusted && status.device_type === 'mobile') {
      mobileViewportAdjusted = true;
      mobileLandscape = false;
      document.body.classList.remove('mobile-landscape');
      const target = { width: 390, height: 844 };
      if (status.viewport.width !== target.width || status.viewport.height !== target.height) {
        await api('viewport', target);
        return refreshStatus();
      }
    }
    activeId = status.active_id || status.tabs[0]?.id;
    updateLoginStatus(status.login);
    if (status.viewport && (screen.width !== status.viewport.width || screen.height !== status.viewport.height)) {
      screen.width = status.viewport.width; screen.height = status.viewport.height;
    }
    if (status.viewport) element('viewport').value = `${status.viewport.width},${status.viewport.height}`;
    element('profile').textContent = `资料：${status.profile}`;
    element('tabs').replaceChildren(...status.tabs.map(tab => {
      const option = document.createElement('option'); option.value = tab.id; option.textContent = tab.title || tab.url; option.selected = tab.id === activeId; return option;
    }));
    const activeTab = status.tabs.find(tab => tab.id === activeId);
    if (document.activeElement !== element('address')) element('address').value = activeTab?.url?.startsWith('data:') ? '' : activeTab?.url || '';
    element('toggle-orientation').textContent = mobileLandscape ? '切换竖屏' : '切换横屏';
    updatePageScrollBar();
    notice(status.busy ? 'Agent 正在读取独立标签页；暂时请不要操作页面。' : status.login?.state === 'pending_confirmation' ? '二维码已扫描，请在手机确认登录。' : '人工登录和验证由你操作；CLI/MCP 可直接使用当前登录会话搜索。');
  } catch (error) { notice(error.message); }
}
async function drawFrame(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    context.drawImage(bitmap, 0, 0, screen.width, screen.height);
    bitmap.close();
    return;
  }
  // 中文说明：部分微信 WebView 没有 createImageBitmap，使用 Image 保证画面仍可解码。
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { context.drawImage(image, 0, 0, screen.width, screen.height); resolve(); };
      image.onerror = reject;
      image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
async function frame() {
  if (frameInFlight) return;
  frameInFlight = true;
  try { await drawFrame(await api('frame', undefined, true)); }
  catch (error) { notice(error.message); }
  finally {
    frameInFlight = false;
    setTimeout(frame, document.hidden ? 2000 : FRAME_INTERVAL);
  }
}
async function act(callback) { try { await callback(); await refreshStatus(); } catch (error) { notice(error.message); } }
element('navigation').addEventListener('submit', event => {
  event.preventDefault();
  const value = element('address').value.trim();
  const url = normalizeNavigationUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  act(() => api('navigate', { url }));
});
element('tabs').addEventListener('change', event => act(() => api('select', { id: event.target.value })));
element('viewport').addEventListener('change', event => {
  const [width, height] = event.target.value.split(',').map(Number);
  act(() => api('viewport', { width, height }));
});
element('toggle-orientation').addEventListener('click', () => act(async () => {
  const nextLandscape = !mobileLandscape;
  const result = await api('viewport', nextLandscape ? { width: 844, height: 390 } : { width: 390, height: 844 });
  mobileLandscape = nextLandscape;
  document.body.classList.toggle('mobile-landscape', mobileLandscape);
  return result;
}));
function pageScroll(deltaY) {
  window.scrollBy({ left: 0, top: deltaY, behavior: 'auto' });
  updatePageScrollBar();
}
function pageScrollTo(top) {
  const maxTop = pageScrollMetrics().maxTop;
  window.scrollTo({ left: 0, top: Math.max(0, Math.min(maxTop, Number(top) || 0)), behavior: 'auto' });
  updatePageScrollBar();
}
const scrollStep = () => Math.max(160, window.innerHeight * 0.7);
element('scroll-up').addEventListener('click', () => pageScroll(-scrollStep()));
element('scroll-down').addEventListener('click', () => pageScroll(scrollStep()));
const scrollTrack = element('scroll-track');
scrollTrack.addEventListener('input', event => {
  if (scrollMetricsUpdating) return;
  pageScrollTo(event.target.value);
});
scrollTrack.addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); pageScroll(-scrollStep()); }
  if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); pageScroll(scrollStep()); }
});
let trackDragging = false;
function trackValueAt(clientY) {
  const rect = scrollTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  return ratio * (Number(scrollTrack.max) || 0);
}
function trackStart(event) {
  event.preventDefault();
  trackDragging = true;
  scrollTrack.setPointerCapture?.(event.pointerId);
  pageScrollTo(trackValueAt(event.clientY));
}
function trackMove(event) {
  if (!trackDragging) return;
  event.preventDefault();
  pageScrollTo(trackValueAt(event.clientY));
}
function trackEnd(event) {
  if (!trackDragging) return;
  event.preventDefault();
  trackDragging = false;
  scrollTrack.releasePointerCapture?.(event.pointerId);
}
scrollTrack.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' && touchCapable) return;
  trackStart(event);
});
scrollTrack.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' && touchCapable) return;
  trackMove(event);
});
scrollTrack.addEventListener('pointerup', event => { if (event.pointerType === 'touch' && touchCapable) return; trackEnd(event); });
scrollTrack.addEventListener('pointercancel', event => { if (event.pointerType === 'touch' && touchCapable) return; trackEnd(event); });
scrollTrack.addEventListener('touchstart', event => {
  const point = event.touches[0];
  if (!point) return;
  trackDragging = true;
  event.preventDefault();
  pageScrollTo(trackValueAt(point.clientY));
}, { passive: false });
scrollTrack.addEventListener('touchmove', event => {
  const point = event.touches[0];
  if (!trackDragging || !point) return;
  event.preventDefault();
  pageScrollTo(trackValueAt(point.clientY));
}, { passive: false });
scrollTrack.addEventListener('touchend', event => {
  if (!trackDragging) return;
  event.preventDefault();
  trackDragging = false;
}, { passive: false });
// 中文说明：侧栏滚轮只滚动微信工作台外层页面；画布内的手势仍滚动远程浏览器网页。
element('page-scroll').addEventListener('wheel', event => {
  event.preventDefault();
  pageScroll(event.deltaY || event.deltaX || 0);
}, { passive: false });
window.addEventListener('scroll', updatePageScrollBar, { passive: true });
window.addEventListener('resize', updatePageScrollBar, { passive: true });
for (const [button, url] of [['home-xhs', 'https://www.xiaohongshu.com/explore'], ['home-zhihu', 'https://www.zhihu.com/signin'], ['home-bilibili', 'https://passport.bilibili.com/login'], ['home-weibo', 'https://weibo.com/newlogin'], ['home-douyin', 'https://www.douyin.com/']]) element(button).addEventListener('click', () => act(() => api('navigate', { url })));
element('text-form').addEventListener('submit', event => { event.preventDefault(); const text = element('text').value; element('text').value = ''; input({ type: 'text', text }); screen.focus(); });
element('enter').addEventListener('click', () => { input({ type: 'key', key: 'Enter', code: 'Enter', keyCode: 13 }); input({ type: 'key', key: 'Enter', code: 'Enter', keyCode: 13, up: true }); screen.focus(); });
function position(event) {
  const rect = screen.getBoundingClientRect();
  if (mobileLandscape) return { x: (event.clientY - rect.top) * screen.width / rect.height, y: (rect.right - event.clientX) * screen.height / rect.width };
  return { x: (event.clientX - rect.left) * screen.width / rect.width, y: (event.clientY - rect.top) * screen.height / rect.height };
}
screen.addEventListener('pointerdown', event => {
  event.preventDefault(); screen.focus(); screen.setPointerCapture?.(event.pointerId);
  // 中文说明：手机优先使用原生触摸事件；部分微信 WebView 虽有 PointerEvent，仍不会持续派发 pointermove。
  if (event.pointerType === 'touch' && touchCapable) return;
  if (event.pointerType === 'touch' && element('touch-mode').value === 'scroll') {
    touch = { start: position(event), last: position(event), moved: false }; return;
  }
  mouseDown = true; input({ type: 'mouse', ...position(event), button: event.button });
});
screen.addEventListener('pointerup', event => {
  if (event.pointerType === 'touch' && touchCapable) return;
  if (touch) {
    if (!touch.moved) { input({ type: 'mouse', ...position(event), button: 0 }); input({ type: 'mouse', ...position(event), button: 0, up: true }); }
    touch = null; return;
  }
  mouseDown = false; input({ type: 'mouse', ...position(event), button: event.button, up: true });
});
screen.addEventListener('pointercancel', event => {
  if (event.pointerType === 'touch' && touchCapable) return;
  if (mouseDown) input({ type: 'mouse', ...position(event), button: 0, up: true });
  touch = null; mouseDown = false;
});
// 中文说明：不论 WebView 是否支持 Pointer Events，都保留原生触摸滚动路径；这能避免微信内置浏览器丢失 pointermove。
screen.addEventListener('touchstart', event => {
  const point = event.touches[0];
  if (!point || element('touch-mode').value !== 'scroll') return;
  event.preventDefault();
  const mapped = position(point);
  touch = { start: mapped, last: mapped, moved: false };
}, { passive: false });
screen.addEventListener('touchmove', event => {
  if (!touch || !event.touches[0]) return;
  event.preventDefault();
  const current = position(event.touches[0]);
  touch.moved ||= Math.hypot(current.x - touch.start.x, current.y - touch.start.y) > 12;
  if (touch.moved && Date.now() - lastMove > 60) {
    lastMove = Date.now();
    input({ type: 'wheel', ...current, deltaX: touch.last.x - current.x, deltaY: touch.last.y - current.y });
    touch.last = current;
  }
}, { passive: false });
screen.addEventListener('touchend', event => {
  if (!touch) return;
  event.preventDefault();
  if (!touch.moved && event.changedTouches[0]) {
    const mapped = position(event.changedTouches[0]);
    input({ type: 'mouse', ...mapped, button: 0 });
    input({ type: 'mouse', ...mapped, button: 0, up: true });
  }
  touch = null;
}, { passive: false });
let lastMove = 0;
screen.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' && touchCapable) return;
  if (touch) {
    const current = position(event);
    touch.moved ||= Math.hypot(current.x - touch.start.x, current.y - touch.start.y) > 12;
    if (touch.moved && Date.now() - lastMove > 80) {
      lastMove = Date.now(); input({ type: 'wheel', ...current, deltaX: touch.last.x - current.x, deltaY: touch.last.y - current.y }); touch.last = current;
    }
  } else if (mouseDown && Date.now() - lastMove > 80) { lastMove = Date.now(); input({ type: 'mouse', ...position(event), move: true }); }
});
screen.addEventListener('contextmenu', event => event.preventDefault());
screen.addEventListener('wheel', event => { event.preventDefault(); input({ type: 'wheel', ...position(event), deltaX: event.deltaX, deltaY: event.deltaY }); }, { passive: false });
screen.addEventListener('keydown', event => {
  if (event.isComposing) return;
  event.preventDefault();
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) input({ type: 'text', text: event.key });
  else input({ type: 'key', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
});
screen.addEventListener('keyup', event => { event.preventDefault(); if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) input({ type: 'key', key: event.key, code: event.code, keyCode: event.keyCode, up: true }); });
if (token) { refreshStatus(); frame(); updatePageScrollBar(); setInterval(refreshStatus, 3000); }
else notice('缺少接管令牌，请使用服务器启动时给出的完整链接。');
