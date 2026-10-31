// 中文说明：独立远程浏览器服务，使用 CDP 转发页面和输入；登录 Profile 留在部署机器，搜索由 CLI/MCP 后台执行。
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.mjs';
import { PROJECT_ROOT, RUN_ROOT, STATE_FILE, PROFILE_ROOT, PROFILE_LOCK_ROOT, TOOL_ROOT, RUNTIME_ROOT, MODULE_ROOT, findBrowser, directoryBytes } from './paths.mjs';
import { htmlToMarkdown, ReadSnapshots, snapshotWindow, snapshotResult, readFormat, imageIndexes, selectImages, workspaceDirectory, contentWindow, compactResult, readLean } from '../../agent-search/shared/reading.mjs';
import { outlineMode, sectionMode } from '../../agent-search/shared/outline.mjs';
import { failureDetails, recoveryFor } from '../../agent-search/shared/recovery.mjs';
import { videoPages, subtitleLanguage, compactMode, subtitleLimits, listTracksMode, subtitleTimeline, subtitleTrack } from '../../agent-search/shared/bilibili.mjs';
import { checkTarget, DEFAULT_NETWORK_POLICY, isDocumentRequestType, policyFromConfig } from '../../agent-search/shared/network-policy.mjs';
import { readResponseBuffer, readResponseText, responseLimit } from '../../agent-search/shared/response-limits.mjs';
import { stopChild } from './process.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// 中文说明：高频短轮询让已完成的页面尽早返回，同时保持约 6 秒的站点动态加载上限。
const AUTOMATION_POLL_INTERVAL = 250;
const AUTOMATION_POLL_ATTEMPTS = 24;
// 中文说明：限制 Agent 读取队列，避免连接失败后的批量重试无限堆积并拖垮浏览器会话。
const AUTOMATION_QUEUE_LIMIT = 8;
function readOffset(value = 0) {
  const offset = Number(value);
  if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isSafeInteger(offset) || offset < 0) {
    throw new HttpError('offset 必须是非负安全整数', 400);
  }
  return offset;
}
// 中文说明：把服务启动时间和源码修改时间写入状态，便于发现源码更新后常驻进程尚未重启。
const SERVER_SOURCE = fileURLToPath(import.meta.url);
class HttpError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}
// 中文说明：字幕资源常位于独立的 aisubtitle 域名，浏览器页面受 CORS 限制；服务端在页面已提供临时资源地址时代为读取。
async function fetchBilibiliSubtitle(sources = [], sourcePages = {}, existingEntries = [], limits = subtitleLimits(false), timing = {}, networkPolicy = null) {
  const entries = [...existingEntries];
  const groups = new Map();
  for (const [index, raw] of sources.entries()) {
    const track = typeof raw === 'string' ? { url: raw, page: sourcePages[raw] ?? index + 1 } : raw;
    if (!track?.url || entries.some(entry => entry.page === track.page)) continue;
    if (!groups.has(track.page)) groups.set(track.page, []);
    groups.get(track.page).push(track);
  }
  for (const tracks of [...groups.values()].slice(0, 12)) {
    for (const track of tracks.slice(0, 8)) {
      const url = track.url.startsWith('//') ? `https:${track.url}` : track.url;
      try {
        if (networkPolicy) await checkTarget(url, networkPolicy);
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const subtitleLimit = responseLimit(response.headers.get('content-type') || '', 'subtitle');
        const payload = JSON.parse(await readResponseText(response, { limitBytes: subtitleLimit.bytes, kind: subtitleLimit.kind, hint: 'subtitle' }));
        const lines = payload?.body || payload?.data?.body || [];
        if (!Array.isArray(lines)) continue;
        const extracted = subtitleTrack(lines, limits.per_page_chars, timing);
        if (extracted.text || extracted.timing?.source_cue_count) {
          entries.push({ page: track.page, title: track.title || '', language: track.language || null, language_label: track.language_label || null, ...extracted, server_fallback: true });
          break;
        }
      } catch { /* 当前网络或临时字幕地址不可用时保留该 P 的失败状态 */ }
    }
  }
  entries.sort((a, b) => a.page - b.page);
  const text = entries.filter(entry => entry.text).map(entry => `P${entry.page}${entry.title ? ' ' + entry.title : ''}：\n${entry.text}`).join('\n\n');
  let end = Math.min(text.length, limits.total_chars);
  if (timing.timestamps && end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { entries, text: text.slice(0, end), page_count: entries.length, source_content_truncated: entries.some(entry => entry.truncated) || text.length > end };
}

// 中文说明：只补取缺失分P，每P保留一个语言轨道；输出语言和缺失状态，内部地址及重复正文不返回给 Agent。
async function hydrateBilibiliSubtitle(structured, networkPolicy = null) {
  const selection = structured.subtitle_selection || {};
  const fallback = await fetchBilibiliSubtitle(structured.subtitle_sources, {}, structured.subtitle_entries, selection.limits, selection, networkPolicy);
  const pages = (structured.subtitle_pages || []).map(page => {
    const entry = fallback.entries.find(entry => entry.page === page.page);
    return entry ? { ...page, status: entry.text ? 'available' : 'no_match', language: entry.language, language_label: entry.language_label, truncated: Boolean(entry.truncated), server_fallback: Boolean(entry.server_fallback) } : page;
  });
  const partial = Boolean(fallback.text) && (fallback.page_count < (structured.subtitle_selection?.pages.length ?? structured.page_count) || structured.source_content_truncated || fallback.source_content_truncated);
  const result = { ...structured, subtitle: fallback.text || null, subtitle_pages: pages,
    subtitle_status: fallback.text ? partial ? 'partial' : 'available' : selection.timestamps && fallback.entries.length ? 'no_match' : structured.subtitle_status,
    subtitle_page_count: fallback.page_count, subtitle_server_fallback: fallback.entries.some(entry => entry.server_fallback),
    source_content_truncated: Boolean(partial || structured.source_content_truncated || fallback.source_content_truncated),
    text: structured.metadata_text + (fallback.text ? '\n字幕：\n' + fallback.text : '') };
  if (selection.timestamps) {
    const totals = { source_cue_count: 0, matched_cue_count: 0, missing_time_count: 0, excluded_untimed_count: 0 };
    const cues = [];
    let offset = 0;
    for (const entry of fallback.entries) {
      for (const key of Object.keys(totals)) totals[key] += entry.timing?.[key] || 0;
      if (!entry.text) continue;
      const prefix = `${offset ? '\n\n' : ''}P${entry.page}${entry.title ? ' ' + entry.title : ''}：\n`;
      offset += prefix.length;
      for (const cue of entry.cues || []) {
        const start = offset + cue.range.start, end = Math.min(offset + cue.range.end, fallback.text.length);
        if (start >= end) continue;
        const base = structured.metadata_text.length + '\n字幕：\n'.length;
        cues.push({ page: entry.page, from: cue.from, to: cue.to,
          url: cue.from === null ? null : `https://www.bilibili.com/video/${structured.bvid}?p=${entry.page}&t=${Math.floor(cue.from)}`,
          range: { start: base + start, end: base + end }, ...(cue.partial || end < offset + cue.range.end ? { partial: true } : {}) });
      }
      offset += entry.text.length;
    }
    result.subtitle_cues = cues;
    result.subtitle_timing = { unit: 'seconds', clock: 'per_page', range_unit: 'utf16', interval: 'overlapping_cues_[start,end)', ...totals };
    const allWithoutTracks = pages.length > 0 && pages.length === selection.pages?.length && pages.every(page => page.status === 'not_available');
    const incomplete = (!allWithoutTracks && fallback.page_count < (selection.pages?.length ?? structured.page_count)) || totals.excluded_untimed_count > 0;
    if (incomplete) {
      result.source_content_truncated = true;
      result.subtitle_status = fallback.text ? 'partial' : 'unavailable';
    }
    const leading = result.text.length - result.text.trimStart().length;
    result.text = result.text.trim();
    for (const cue of cues) { cue.range.start -= leading; cue.range.end -= leading; }
  }
  delete result.subtitle_sources;
  delete result.subtitle_source_pages;
  delete result.subtitle_entries;
  delete result.metadata_text;
  return result;
}
// 中文说明：只把用户显式指定的小红书图片保存到项目工作区，返回文件元数据而不是把二进制塞进 Agent 上下文。
async function downloadImages(images = [], requestedDirectory, decodeImage, networkPolicy = DEFAULT_NETWORK_POLICY) {
  const requested = String(requestedDirectory || '').trim();
  if (!requested) throw new Error('下载图片需要指定目录');
  const directory = await workspaceDirectory(PROJECT_ROOT, requested);
  const downloaded = [];
  const errors = [];
  for (const image of images.slice(0, 20)) {
    const index = Number(image?.index) || downloaded.length + errors.length + 1;
    try {
      const url = new URL(String(image?.url || ''));
      if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('图片地址协议不受支持'), { code: 'image_url_invalid' });
      await checkTarget(url.toString(), networkPolicy);
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } });
      if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status, { code: `http_${response.status}`, retry_after: response.headers.get('retry-after') });
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
      if (!contentType.startsWith('image/')) throw Object.assign(new Error(`响应类型不是图片（${contentType || '未知'}）`), { code: 'image_content_type_invalid' });
      const imageLimit = responseLimit(contentType, 'image');
      const data = await readResponseBuffer(response, { limitBytes: imageLimit.bytes, kind: imageLimit.kind, hint: 'image' });
      const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg' })[contentType] || path.extname(url.pathname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.img';
      const file = path.join(directory, `${String(index).padStart(2, '0')}${extension}`);
      await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
      // 中文说明：保留旧 width/height 的站点清单语义，另用现有 Chromium 解码实际文件；解码失败不丢弃已保存的文件。
      let size = null, decodeError = null;
      try {
        size = await decodeImage(data, contentType);
        if (!Number.isSafeInteger(size?.width) || size.width <= 0 || !Number.isSafeInteger(size?.height) || size.height <= 0) {
          size = null;
          decodeError = 'image_decode_failed';
        }
      } catch { decodeError = 'image_decode_unavailable'; }
      downloaded.push({ ...image, file, content_type: contentType, bytes: data.length,
        decoded: Boolean(size), actual_width: size?.width ?? null, actual_height: size?.height ?? null,
        manifest_dimensions_match: size && Number(image.width) > 0 && Number(image.height) > 0 ? size.width === Number(image.width) && size.height === Number(image.height) : null,
        ...(decodeError ? { decode_error: decodeError } : {}) });
    } catch (error) {
      errors.push({ ...image, error: error.message, ...failureDetails(error.name === 'TimeoutError' ? { code: 'request_timeout' } : error, 'image_download_failed') });
    }
  }
  for (const image of images.slice(20)) errors.push({ ...image, error: '本次最多下载 20 张图片，请按 image_indexes 分批下载' });
  return { directory, downloaded, errors };
}
// 中文说明：浏览器启动页使用本地欢迎页，避免工作台首次显示空白的 about:blank。
const STARTUP_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>等待操作</title><style>body{margin:0;padding:12vh 8vw;background:#233043;color:#fff;font:20px system-ui,sans-serif;text-align:center}p{color:#cbd5e1;font-size:16px}</style><h1>远程浏览器已启动</h1><p>请在工作台选择网站，或由 Agent 调用搜索。</p>')}`;
// 中文说明：知乎登录页在窄视口下会把二维码布局放到视口左侧并隐藏横向溢出；扩展其登录内容宽度，让二维码可见且可横向拖动。
const HORIZONTAL_LAYOUT_FIX = `(() => {
  const fix = () => {
    if (!/^(?:[^.]+\\.)*zhihu\\.com$/i.test(location.hostname)) return;
    const outer = document.querySelector('.SignFlowHomepage');
    const content = document.querySelector('.SignFlowHomepage-content');
    const qr = document.querySelector('.signQr-container');
    if (!outer || !content || !qr) return;
    const width = Math.ceil(Math.max(content.getBoundingClientRect().width, qr.getBoundingClientRect().width));
    if (width > content.clientWidth + 1) {
      content.style.width = width + 'px';
      content.style.minWidth = width + 'px';
    }
    outer.style.overflowX = 'auto';
  };
  if (document.documentElement) new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  fix();
})();`;
// 中文说明：从页面元数据和 JSON-LD 提取通用作者、发布时间及互动统计，减少 Agent 只拿到无结构正文的情况。
const PAGE_METADATA = `(() => {
  const text = value => typeof value === 'string' ? value.trim() : value == null ? null : String(value).trim();
  const meta = (...names) => {
    for (const name of names) {
      const node = document.querySelector('meta[name="' + name + '"],meta[property="' + name + '"]');
      const value = text(node?.content);
      if (value) return value;
    }
    return null;
  };
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(node => {
    try {
      const value = JSON.parse(node.textContent || 'null');
      return Array.isArray(value) ? value : value ? [value] : [];
    } catch { return []; }
  });
  const records = jsonLd.flatMap(value => Array.isArray(value?.['@graph']) ? value['@graph'] : [value]);
  const first = (...values) => values.map(text).find(Boolean) || null;
  const author = first(meta('author', 'article:author', 'og:author'), ...records.map(item => typeof item?.author === 'string' ? item.author : item?.author?.name));
  const publishedAt = first(meta('article:published_time', 'datePublished', 'publishdate', 'pubdate'), document.querySelector('time[datetime]')?.dateTime, ...records.map(item => item?.datePublished || item?.uploadDate || item?.dateCreated));
  const stats = {};
  const addStat = (name, value) => { const normalized = text(value); if (normalized) stats[name] = normalized; };
  for (const item of records) {
    const interactions = Array.isArray(item?.interactionStatistic) ? item.interactionStatistic : item?.interactionStatistic ? [item.interactionStatistic] : [];
    for (const interaction of interactions) {
      const type = String(interaction?.interactionType || '').toLowerCase();
      const count = interaction?.userInteractionCount;
      if (/like|upvote|favorite/.test(type)) addStat('likes', count);
      else if (/comment|reply/.test(type)) addStat('comments', count);
      else if (/watch|view|read/.test(type)) addStat('views', count);
    }
  }
  addStat('likes', meta('interactionCountLike', 'likeCount', 'like_count'));
  addStat('comments', meta('commentCount', 'comment_count'));
  addStat('views', meta('viewCount', 'view_count'));
  return { author, published_at: publishedAt, stats: Object.keys(stats).length ? stats : null };
})()`;
// 中文说明：B 站搜索卡片的锚点文本通常先包含播放量、弹幕数和时长；按卡片专用选择器提取，避免把统计数字当成标题。
const BILIBILI_SEARCH = String.raw`(() => {
  const links = [...document.querySelectorAll('a[href*="/video/"]')];
  const seen = new Set();
  const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const pick = (root, selectors) => {
    for (const selector of selectors) {
      const value = text(root?.querySelector(selector));
      if (value) return value;
    }
    return '';
  };
  return links.map(link => {
    const url = link.href;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    // 只接受 B 站公开视频地址，排除投稿、弹幕等后台链接以及外部站点。
    if (!/^https?:$/.test(parsed.protocol) || !/(^|\.)bilibili\.com$/i.test(parsed.hostname) || !/^\/video\/BV[0-9A-Za-z]+\/?(?:[?#].*)?$/.test(parsed.pathname + parsed.search + parsed.hash) || seen.has(url)) return null;
    seen.add(url);
    const card = link.closest('.bili-video-card, .video-page-card, [class*="video-card"], section, article') || link.parentElement;
    const title = pick(card, ['.bili-video-card__info--tit', '[class*="info--tit"]', '[class*="title"]']) || link.getAttribute('title') || text(link);
    const author = pick(card, ['.bili-video-card__info--author', '[class*="author"]', '[class*="up-name"]']);
    const published = pick(card, ['.bili-video-card__info--date', '[class*="date"]', 'time']);
    const statsRoot = card?.querySelector('.bili-video-card__stats, [class*="stats"]');
    const statNodes = [...(statsRoot?.querySelectorAll('.bili-video-card__stats--item-text, .bili-video-card__stats--item > span') || [])].map(text).filter(Boolean);
    const duration = text(statsRoot?.querySelector('.bili-video-card__stats__duration, [class*="stats__duration"]'));
    const fallbackStats = text(statsRoot).split(/\n|\s{2,}/).map(value => value.trim()).filter(Boolean);
    const values = (statNodes.length ? [...statNodes, duration] : fallbackStats).filter(Boolean).slice(0, 3);
    const stats = {};
    if (values[0]) stats.views = values[0];
    if (values[1]) stats.comments = values[1];
    if (values[2]) stats.duration = values[2];
    return { title: title.slice(0, 240), url, summary: text(card).slice(0, 1200), author: author || null, published_at: published || null, stats: Object.keys(stats).length ? stats : null };
  }).filter(item => item && item.title && /^BV[0-9A-Za-z]+/.test(item.url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '')).slice(0, 50);
})()`;
// 中文说明：抖音搜索结果使用瀑布流卡片，视频 ID 在 waterfall_item_<数字> 外层节点中，页面通常不生成视频锚点。
const DOUYIN_SEARCH = String.raw`(() => {
  const limit = Math.max(1, Math.min(Number(__LIMIT__) || 10, 50));
  const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const cards = [...document.querySelectorAll('.search-result-card')];
  const seen = new Set();
  return cards.map(card => {
    const item = card.closest('[id^="waterfall_item_"]');
    const rawId = String(item?.id || '').replace(/^waterfall_item_/, '');
    if (!/^\d{8,}$/.test(rawId) || seen.has(rawId)) return null;
    const title = text(card.querySelector('.BjLsdJMi')) || text(card).slice(0, 240);
    if (!title) return null;
    seen.add(rawId);
    const author = text(card.querySelector('.WldPmwm5')) || null;
    const published = text(card.querySelector('.dO8W7uoF')).replace(/^·\s*/, '') || null;
    const duration = text(card.querySelector('.FnM1bbIQ')) || null;
    const likes = text(card.querySelector('.pMq55q1M')) .replace(/^[^\d]*/, '') || null;
    const stats = {};
    if (likes) stats.likes = likes;
    if (duration) stats.duration = duration;
    const url = 'https://www.douyin.com/video/' + rawId;
    return { title: title.slice(0, 240), url, summary: text(card).slice(0, 1200), author, published_at: published, stats: Object.keys(stats).length ? stats : null };
  }).filter(Boolean).slice(0, limit);
})()`;
// 中文说明：B 站视频详情优先读取同源公开接口；字幕若已提供则读取字幕 JSON，失败时回退到普通可见文本。
const BILIBILI_READ = String.raw`async (options = {}) => {
  const readTrack = ${subtitleTrack.toString()};
  const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  const bvid = match?.[1] || options.bvid;
  if (!bvid) return { ready: false, diagnostic_code: 'not_video_url' };
  let metadataRequests = 0, subtitleRequests = 0;
  const getJson = async (path, subtitle = false) => {
    if (subtitle) subtitleRequests++; else metadataRequests++;
    try {
      const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) return { ok: false, status: response.status, data: null };
      return { ok: true, status: response.status, data: await response.json() };
    } catch (error) {
      return { ok: false, status: null, data: null, error: error?.name || 'request_failed' };
    }
  };
  const apiOrigin = 'https://api.bilibili.com';
  const viewResponse = await getJson(apiOrigin + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
  const view = viewResponse.data;
  if (!viewResponse.ok || !view || view.code !== 0 || !view.data) return { ready: false, diagnostic_code: viewResponse.ok ? 'api_rejected' : 'api_request_failed', api_code: view?.code ?? null, api_status: viewResponse.status, api_error: viewResponse.error || null };
  const video = view.data;
  const owner = video.owner || {};
  const stat = video.stat || {};
  const pages = Array.isArray(video.pages) ? video.pages : [];
  if (options.list_tracks && !pages.length) return { ready: false, diagnostic_code: 'video_pages_missing' };
  const page = pages[0] || {};
  const urlPage = !options.pages && (options.url_page ?? new URLSearchParams(location.search || '').get('p'));
  const requestedPages = options.pages || (urlPage ? [Number(urlPage)] : null);
  if (requestedPages?.some(p => !Number.isSafeInteger(p) || p < 1 || p > pages.length)) return { ready: true, request_error: { code: 'bilibili_pages_out_of_range', message: '请求的分P不存在；此视频共' + pages.length + 'P' } };
  const selectionMode = options.pages ? 'explicit' : urlPage ? 'url' : 'default';
  const selectedPages = requestedPages || pages.slice(0, 12).map((_, i) => i + 1);
  const limits = options.compact ? ${JSON.stringify(subtitleLimits(true))} : ${JSON.stringify(subtitleLimits(false))};
  const selection = { pages: selectedPages, mode: selectionMode, requested_language: options.subtitle_language || null, total_pages: pages.length, unrequested_page_count: pages.length - selectedPages.length, limits };
  if (options.timestamps) Object.assign(selection, { timestamps: true, time_range: options.start_seconds !== undefined || options.end_seconds !== undefined, start_seconds: options.start_seconds ?? 0, end_seconds: options.end_seconds ?? null });
  // 多 P 视频逐个查询字幕轨道；每 P 只取有限轨道，避免把字幕请求变成上下文爆炸。
  const subtitleEntries = [];
  const subtitleSources = [];
  const subtitleSourcePages = {};
  const subtitlePages = [];
  const subtitleFailures = [];
  let sourceTruncated = !requestedPages && pages.length > 12;
  for (const pageNumber of selectedPages) {
    const pageIndex = pageNumber - 1, pageInfo = pages[pageIndex];
    const pageResult = { page: pageIndex + 1, title: pageInfo.part || '', status: 'unavailable', language: null, language_label: null, available_languages: [] };
    subtitlePages.push(pageResult);
    if (!pageInfo.cid) { subtitleFailures.push({ page: pageIndex + 1, reason: 'cid_missing' }); continue; }
    // 使用页面播放器的 WBI 接口；实测旧 v2 接口可能返回不同字幕轨道，不再用它作为降级来源。
    const playerResponse = await getJson(apiOrigin + '/x/player/wbi/v2?aid=' + encodeURIComponent(video.aid) + '&cid=' + encodeURIComponent(pageInfo.cid));
    if (!playerResponse.ok) {
      subtitleFailures.push({ page: pageIndex + 1, status: playerResponse.status, reason: playerResponse.error || 'player_request_failed' });
      continue;
    }
    const player = playerResponse.data;
    if (player?.code !== 0 || !player.data) {
      subtitleFailures.push({ page: pageIndex + 1, status: playerResponse.status, reason: 'player_api_rejected', api_code: player?.code ?? null });
      continue;
    }
    if ((player.data.aid != null && String(player.data.aid) !== String(video.aid))
      || (player.data.cid != null && String(player.data.cid) !== String(pageInfo.cid))
      || (player.data.bvid != null && player.data.bvid !== bvid)) {
      subtitleFailures.push({ page: pageIndex + 1, status: playerResponse.status, reason: 'player_video_mismatch' });
      continue;
    }
    const subtitleList = player?.data?.subtitle?.subtitles || player?.data?.subtitle?.list || (options.list_tracks ? null : []);
    if (!Array.isArray(subtitleList)) { subtitleFailures.push({ page: pageIndex + 1, reason: subtitleList == null ? 'subtitle_list_missing' : 'subtitle_list_invalid' }); continue; }
    // 默认优先中文，其次英文，再保留接口顺序；每P选一个可读轨道，避免把翻译拼成重复正文。
    const languagePriority = item => /^(?:ai-)?zh(?:-|$)/i.test(item.lan || '') ? 0 : /^(?:ai-)?en(?:-|$)/i.test(item.lan || '') ? 1 : 2;
    const orderedTracks = [...subtitleList].sort((a, b) => languagePriority(a) - languagePriority(b));
    const tracks = (options.subtitle_language ? orderedTracks.filter(item => String(item.lan || '').toLowerCase() === options.subtitle_language) : orderedTracks).slice(0, 8);
    pageResult.status = subtitleList.length ? 'unavailable' : 'not_available';
    pageResult.available_languages = (options.list_tracks ? orderedTracks : orderedTracks.slice(0, 8)).map(item => ({ language: item.lan || null, label: item.lan_doc || null }));
    pageResult.track_count = subtitleList.length;
    if (options.list_tracks) {
      pageResult.status = subtitleList.length ? 'listed' : 'not_available';
      continue;
    }
    if (options.subtitle_language && !tracks.length) {
      pageResult.status = 'language_unavailable';
      subtitleFailures.push({ page: pageNumber, reason: 'subtitle_language_unavailable' });
    }
    for (const item of tracks) {
      const rawUrl = item.subtitle_url || item.subtitleUrl || item.url;
      if (!rawUrl) continue;
      const normalizedUrl = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
      subtitleSources.push({ url: normalizedUrl, page: pageIndex + 1, title: pageInfo.part || '', language: item.lan || null, language_label: item.lan_doc || null });
      subtitleSourcePages[normalizedUrl] = pageIndex + 1;
    }
    for (const track of subtitleSources.filter(track => track.page === pageIndex + 1)) {
      const normalizedUrl = track.url;
      const subtitleResponse = await getJson(normalizedUrl, true);
      if (!subtitleResponse.ok) {
        subtitleFailures.push({ page: pageIndex + 1, status: subtitleResponse.status, reason: subtitleResponse.error || 'subtitle_request_failed' });
        continue;
      }
      const subtitleData = subtitleResponse.data;
      const lines = subtitleData?.body || subtitleData?.data?.body || [];
      if (!Array.isArray(lines)) { subtitleFailures.push({ page: pageIndex + 1, reason: 'subtitle_body_invalid' }); continue; }
      const extracted = readTrack(lines, limits.per_page_chars, options);
      if (extracted.text || extracted.timing?.source_cue_count) {
        if (extracted.truncated) sourceTruncated = true;
        subtitleEntries.push({ page: pageIndex + 1, title: pageInfo.part || '', language: track.language, language_label: track.language_label, ...extracted });
        Object.assign(pageResult, { status: 'available', language: track.language, language_label: track.language_label });
        break;
      }
    }
  }
  if (options.list_tracks) return {
    ready: true, bilibili_catalog: true, response_mode: 'catalog', content: null, content_status: 'metadata_only',
    title: video.title || document.title, author: owner.name || null, published_at: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : null,
    catalog_status: subtitleFailures.length ? 'partial' : 'complete',
    video_catalog: {
      bvid, total_pages: pages.length, selected_pages: selectedPages, selection_mode: selectionMode, uninspected_page_count: pages.length - selectedPages.length,
      pages: subtitlePages.map(p => ({ page: p.page, title: p.title, duration_seconds: pages[p.page - 1].duration ?? null,
        track_status: p.status, track_count: p.track_count ?? null, languages: p.available_languages,
        ...(subtitleFailures.some(f => f.page === p.page) ? { error: subtitleFailures.find(f => f.page === p.page) } : {}) })),
      requests: { metadata: metadataRequests, subtitle: subtitleRequests }
    },
    warnings: ['仅列出接口提供的字幕轨道，未下载字幕正文；轨道存在不保证正文可访问',
      ...(selectedPages.length < pages.length ? ['仅检查所选分P，其他分P的轨道尚未查询'] : []),
      ...(subtitleFailures.length ? ['部分分P的轨道查询失败，不能据此断言没有字幕'] : [])]
  };
  const fullSubtitle = subtitleEntries.filter(entry => entry.text).map(entry => 'P' + entry.page + (entry.title ? ' ' + entry.title : '') + '：\n' + entry.text).join('\n\n');
  const subtitle = fullSubtitle.slice(0, limits.total_chars);
  sourceTruncated ||= fullSubtitle.length > limits.total_chars;
  const parts = [video.title, video.desc, '作者：' + (owner.name || ''), '播放：' + (stat.view ?? ''), '点赞：' + (stat.like ?? ''), '评论：' + (stat.reply ?? ''), '收藏：' + (stat.favorite ?? ''), '时长：' + (video.duration || page.duration || '')];
  return { bvid, title: video.title || document.title, author: owner.name || null, published_at: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : null, stats: { views: stat.view, likes: stat.like, comments: stat.reply, favorites: stat.favorite }, subtitle: subtitle || null, subtitle_sources: subtitleSources, subtitle_source_pages: subtitleSourcePages, subtitle_entries: subtitleEntries, subtitle_selection: selection, subtitle_pages: subtitlePages, source_content_truncated: sourceTruncated, subtitle_status: subtitle ? 'available' : subtitleSources.length || subtitleFailures.length ? 'unavailable' : 'not_available', subtitle_failure_count: subtitleFailures.length, subtitle_failures: subtitleFailures.slice(0, 12), page_count: pages.length, subtitle_page_count: subtitleEntries.length, subtitle_track_count: subtitleSources.length, metadata_text: parts.filter(Boolean).join('\n'), text: parts.concat(subtitle ? ['字幕：\n' + subtitle] : []).filter(Boolean).join('\n'), ready: true, bilibili_api: true };
}`;
// 中文说明：知乎页面把文章/回答正文和元数据放在 js-initialData，优先解析该数据，避免推荐内容和登录提示污染正文。
const ZHIHU_READ = String.raw`(() => {
  const articleMatch = location.pathname.match(/^\/p\/(\d+)/);
  const answerMatch = location.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)/);
  const questionMatch = location.pathname.match(/^\/question\/(\d+)\/?$/);
  if (!articleMatch && !answerMatch && !questionMatch) return { ready: false, diagnostic_code: 'not_detail_url' };
  if (document.querySelector?.('.ErrorPage')) return { ready: true, site_unavailable: true, diagnostic_code: 'site_error_page' };
  const id = articleMatch?.[1] || answerMatch?.[2] || questionMatch?.[1];
  const questionWithoutAnswer = Boolean(questionMatch);
  const script = document.getElementById('js-initialData');
  if (!script?.textContent) return { ready: false, diagnostic_code: 'initial_data_missing' };
  let state;
  try { state = JSON.parse(script.textContent).initialState || {}; } catch { return { ready: false, diagnostic_code: 'initial_data_invalid' }; }
  const entity = questionWithoutAnswer ? state.entities?.questions?.[id] : state.entities?.articles?.[id] || state.entities?.answers?.[id];
  if (!entity) return { ready: false, diagnostic_code: 'entity_missing' };
  const html = entity.content || '';
  const excerptHtml = entity.excerpt || entity.description || entity.detail || '';
  const holder = document.createElement('div');
  holder.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|section|blockquote|pre|tr)>/gi, '\n');
  const body = (holder.innerText || holder.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const excerptHolder = document.createElement('div');
  excerptHolder.innerHTML = excerptHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|section|blockquote|pre|tr)>/gi, '\n');
  const excerpt = (excerptHolder.innerText || excerptHolder.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const author = entity.author?.name || null;
  const timestamp = Number(entity.created || entity.createdTime || entity.updated || entity.updatedTime);
  const publishedAt = timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null;
  const stats = {};
  if (entity.voteupCount != null || entity.likeCount != null) stats.likes = entity.voteupCount ?? entity.likeCount;
  if (entity.commentCount != null) stats.comments = entity.commentCount;
  if (entity.thanksCount != null) stats.thanks = entity.thanksCount;
  const title = entity.title || document.title;
  const text = [title, author ? '作者：' + author : '', body || excerpt].filter(Boolean).join('\n\n');
  const diagnosticCode = questionWithoutAnswer ? 'question_without_answer' : body ? null : excerpt ? 'body_excerpt_only' : 'body_missing';
  return { title, author, published_at: publishedAt, stats: Object.keys(stats).length ? stats : null, text, body_html: html || excerptHtml, ready: true, zhihu_initial_data: true, body_text_missing: !body, body_is_excerpt: !body && Boolean(excerpt), question_without_answer: questionWithoutAnswer, answer_count: entity.answerCount ?? entity.answer_count ?? null, diagnostic_code: diagnosticCode, source_content_truncated: Boolean(entity.contentNeedTruncated) };
})`;
// 中文说明：小红书笔记详情会把正文、作者和互动字段放在 __INITIAL_STATE__.noteDetailMap；使用搜索结果中的 xsec_token 才能稳定命中详情。
const XIAOHONGSHU_READ = String.raw`(() => {
  const match = location.pathname.match(/^\/(?:explore|search_result|discovery\/item|item)\/([0-9a-z]+)/i);
  if (!match) return { ready: false, diagnostic_code: 'not_detail_url' };
  const noteId = match[1];
  const detail = window.__INITIAL_STATE__?.note?.noteDetailMap?.[noteId] || window.__INITIAL_STATE__?.note?.noteDetailMap?.[String(noteId)];
  const note = detail?.note || detail;
  if (!detail) return { ready: false, diagnostic_code: 'initial_state_missing' };
  if (!note) return { ready: false, diagnostic_code: 'note_missing' };
  const stats = {};
  const interactions = note.interactInfo || {};
  for (const [target, key] of [['likes', 'likedCount'], ['comments', 'commentCount'], ['shares', 'shareCount'], ['favorites', 'collectedCount']]) {
    if (interactions[key] !== undefined && interactions[key] !== '') stats[target] = interactions[key];
  }
  const title = note.title || document.title;
  const author = note.user?.nickname || null;
  const body = String(note.desc || '').trim();
  const timestamp = Number(note.time || note.lastUpdateTime);
  const publishedAt = timestamp > 0 ? new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString() : null;
  const images = (Array.isArray(note.imageList) ? note.imageList : []).map((item, index) => {
    const rawUrl = item.infoList?.find(info => info.imageScene === 'WB_DFT')?.url || item.urlDefault || item.urlPre || item.url;
    if (!rawUrl) return null;
    return { index: index + 1, url: String(rawUrl).replace(/^http:/, 'https:'), width: item.width || null, height: item.height || null };
  }).filter(Boolean);
  const text = [title, author ? '作者：' + author : '', body].filter(Boolean).join('\n\n');
  return { title, author, published_at: publishedAt, stats: Object.keys(stats).length ? stats : null, text, ready: true, xiaohongshu_initial_state: true, body_text_missing: !body, diagnostic_code: body ? null : 'body_missing', media_count: images.length, images, note_type: note.type || null };
})`;
// 中文说明：微博桌面详情页在当前代理节点会关闭连接；移动详情页包含稳定的作者、时间、正文和图片节点。
const WEIBO_READ = String.raw`(() => {
  if (!/(^|\.)weibo\.cn$/i.test(location.hostname) || !/^\/detail\/\d+/i.test(location.pathname)) return { ready: false, diagnostic_code: 'not_weibo_mobile_detail' };
  const root = document.querySelector('.card.f-weibo');
  const bodyNode = root?.querySelector('.weibo-text');
  const body = (bodyNode?.innerText || bodyNode?.textContent || '').replace(/\s+$/u, '').trim();
  const author = (root?.querySelector('.weibo-top h3')?.innerText || '').replace(/\s+/g, ' ').trim();
  const time = (root?.querySelector('.weibo-top .time')?.innerText || '').replace(/\s+/g, ' ').trim();
  const stats = {};
  const statNodes = document.querySelectorAll?.('.lite-page-tab .tab-item, .card-act .tab-item, .card.f-weibo .tab-item') || [];
  for (const item of [...statNodes]) {
    const parts = [...(item.querySelectorAll?.('i') || [])].map(node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const raw = parts.slice(1).join(' ') || (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim();
    const value = raw.match(/[\d,.]+(?:万|亿)?/u)?.[0];
    const label = parts[0] || raw.replace(value || '', '').trim();
    if (!value) continue;
    if (/转发|分享/u.test(label)) stats.shares = value;
    else if (/评论/u.test(label)) stats.comments = value;
    else if (/赞/u.test(label)) stats.likes = value;
    else if (/收藏/u.test(label)) stats.favorites = value;
  }
  const images = [...(root?.querySelectorAll('.weibo-media img') || [])].map((img, index) => ({ index: index + 1, url: img.currentSrc || img.src, width: img.naturalWidth || null, height: img.naturalHeight || null })).filter(item => /^https?:/i.test(item.url || ''));
  const text = [author ? '作者：' + author : '', time ? '发布时间：' + time : '', body].filter(Boolean).join('\n\n');
  return { title: author ? author + ' 的微博' : document.title, author: author || null, published_at: time || null, stats: Object.keys(stats).length ? stats : null, text, ready: Boolean(body), weibo_mobile: true, body_text_missing: !body, diagnostic_code: body ? null : 'body_missing', media_count: images.length, images };
})`;
const SITE_SEARCH = {
  xiaohongshu: { url: q => `https://www.xiaohongshu.com/search_result?keyword=${q}`, links: 'a[href*="/search_result/"],a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/item/"]' },
  zhihu: { url: q => `https://www.zhihu.com/search?type=content&q=${q}`, links: 'a[href*="/question/"],a[href*="zhuanlan.zhihu.com/p/"],a[href*="/zvideo/"]' },
  bilibili: { url: q => `https://search.bilibili.com/all?keyword=${q}`, links: 'a[href*="/video/"]' },
  youtube: { url: q => `https://www.youtube.com/results?search_query=${q}`, links: 'a#video-title' },
  reddit: { url: q => `https://www.reddit.com/search/?q=${q}`, links: 'a[href*="/comments/"]' },
  // 中文说明：微博搜索结果使用 /用户ID/短ID 详情地址，旧版 /status/ 和 /detail/ 选择器已失效。
  weibo: { url: q => `https://s.weibo.com/weibo?q=${q}`, links: 'a[node-type="feed_list_content"],a[action-type="fl_unfold"],a[href*="/status/"],a[href*="/detail/"]' },
  douyin: { url: q => `https://www.douyin.com/search/${q}`, links: 'a[href*="/video/"]' },
  gitee: { url: q => `https://search.gitee.com/?q=${q}&type=repository`, links: 'a[href^="https://gitee.com/"]' }
};

// 中文说明：微博没有稳定的标题字段；从搜索卡片提取作者、时间、正文和详情链接，避免把用户页或导航链接当结果。
const WEIBO_SEARCH = String.raw`(() => {
  const limit = Math.max(1, Math.min(Number(__LIMIT__) || 10, 50));
  const detailPattern = /^https?:\/\/weibo\.com\/\d+\/[A-Za-z0-9]+(?:[?#].*)?$/i;
  const items = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('.card-wrap[action-type="feed_list_item"], .card-wrap .card-feed')) {
    const root = card.matches('.card-wrap') ? card : card.closest('.card-wrap');
    if (!root) continue;
    const contentNode = root.querySelector('[node-type="feed_list_content_full"]') || root.querySelector('[node-type="feed_list_content"]');
    const content = (contentNode?.innerText || contentNode?.textContent || '').replace(/\s+展开[\s\S]*$/u, '').replace(/\s+/g, ' ').trim();
    const author = (root.querySelector('.name')?.innerText || root.querySelector('[nick-name]')?.getAttribute('nick-name') || '').trim();
    const timeLink = [...root.querySelectorAll('a[href]')].find(a => {
      try { return detailPattern.test(new URL(a.href, location.href).href); } catch { return false; }
    });
    const webUrl = timeLink ? new URL(timeLink.href, location.href).href : '';
    // 中文说明：微博桌面详情页在当前代理节点会主动关闭连接；移动详情页可复用同一会话并返回完整正文。
    const mid = root.getAttribute('mid')?.trim();
    const url = mid ? 'https://m.weibo.cn/detail/' + encodeURIComponent(mid) : webUrl;
    if (!url || seen.has(url) || !content) continue;
    seen.add(url);
    const time = (timeLink?.innerText || '').replace(/\s+/g, ' ').trim();
    const stats = {};
    for (const [target, action] of [['shares', 'feed_list_forward'], ['comments', 'feed_list_comment'], ['likes', 'feed_list_like']]) {
      const actionNode = root.querySelector('[action-type="' + action + '"]');
      const raw = (actionNode?.innerText || '').replace(/\s+/g, ' ').trim();
      const match = raw.match(/[\d,.]+(?:万|亿)?/);
      if (match) stats[target] = match[0];
    }
    const title = [author, content].filter(Boolean).join('：').slice(0, 240);
    const summary = [author, time, content].filter(Boolean).join('\n').slice(0, 1200);
    items.push({ title: title || content.slice(0, 240), url, summary, ...(author ? { author } : {}), ...(time ? { published_at: time } : {}), ...(Object.keys(stats).length ? { stats } : {}), ...(webUrl ? { source_url: webUrl } : {}) });
    if (items.length >= limit) break;
  }
  return items;
})()`;

function validUrl(value) {
  const raw = String(value || '').trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只允许 http(s) 网页地址');
  return url.toString();
}
// 中文说明：登录站点跳回首页、登录页或搜索页时，不能把导航内容当作详情正文。
function detailNavigationUnavailable(originalUrl, finalUrl) {
  try {
    const original = new URL(originalUrl);
    const current = new URL(finalUrl || originalUrl);
    const onHost = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (onHost(original.hostname, 'xiaohongshu.com') && /\/(?:explore|search_result|discovery\/item|item)\/[0-9a-z]+/i.test(original.pathname)) {
      return !onHost(current.hostname, 'xiaohongshu.com') || !/\/(?:explore|search_result|discovery\/item|item)\/[0-9a-z]+/i.test(current.pathname);
    }
    if (onHost(original.hostname, 'zhihu.com') && (/\/p\/[^/?#]+/i.test(original.pathname) || /\/question\/[^/?#]+/i.test(original.pathname))) {
      return !onHost(current.hostname, 'zhihu.com') || !(/\/p\/[^/?#]+/i.test(current.pathname) || /\/question\/[^/?#]+/i.test(current.pathname));
    }
    if (onHost(original.hostname, 'bilibili.com') && /\/video\/[a-z0-9]+/i.test(original.pathname)) {
      return !onHost(current.hostname, 'bilibili.com') || !/\/video\/[a-z0-9]+/i.test(current.pathname);
    }
    if (onHost(original.hostname, 'douyin.com') && /^\/video\/\d+/.test(original.pathname)) {
      const originalId = original.pathname.match(/^\/video\/(\d+)/)?.[1];
      const currentId = current.pathname.match(/^\/video\/(\d+)/)?.[1] || current.searchParams.get('modal_id');
      return !onHost(current.hostname, 'douyin.com') || currentId !== originalId;
    }
    const weiboDetail = /^\/(?:\d+\/[a-z0-9]+|(?:detail|status)\/[a-z0-9]+)\/?$/i;
    if (onHost(original.hostname, 'weibo.com') && weiboDetail.test(original.pathname)) {
      return !onHost(current.hostname, 'weibo.com') || !weiboDetail.test(current.pathname);
    }
  } catch { return true; }
  return false;
}
// 中文说明：抖音详情页会把正文放在 meta description；该字段包含作品文案、作者、日期和点赞数，但不等同于视频字幕或画面内容。
const DOUYIN_READ = String.raw`(() => {
  const meta = name => document.querySelector('meta[name="' + name + '"]')?.content?.trim() || '';
  const description = meta('description');
  const videoTitle = meta('lark:url:video_title');
  const suffix = description.match(/\s+-\s+(.+?)于(\d{8})发布在抖音，已经收获了(.+?)个喜欢(?:，|,|$)/);
  const body = (suffix ? description.slice(0, suffix.index) : (description || videoTitle)).replace(/\s+/g, ' ').trim();
  const author = suffix?.[1]?.trim() || null;
  const published = suffix?.[2] ? suffix[2].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
  const likes = suffix?.[3]?.trim() || null;
  if (!body && !author) return { ready: false, diagnostic_code: 'metadata_missing' };
  if (!suffix && /^于\d{8}发布在抖音，已经收获了.+?个喜欢/.test(body)) return { ready: false, diagnostic_code: 'metadata_incomplete' };
  const stats = likes ? { likes } : null;
  return {
    ready: true,
    douyin_metadata: true,
    title: body.slice(0, 240),
    text: body,
    author,
    published_at: published,
    metadata: { author, published_at: published, stats },
    stats,
    body_is_excerpt: false,
    warning_code: 'video_media_not_transcribed'
  };
})()`;
// 中文说明：抖音仅有导航和“视频数据加载中”时继续等待；耗尽现有预算后标记未取得详情。
function detailContentPending(url, text) {
  const parsed = new URL(url);
  return /(^|\.)douyin\.com$/i.test(parsed.hostname) && /^\/video\//.test(parsed.pathname) && /视频数据加载中/.test(text || '');
}
// 中文说明：实测抖音、微博无效详情和 YouTube 无效视频会显示不可用提示；这些提示都不是作品正文。
function detailContentUnavailable(url, text) {
  const parsed = new URL(url);
  if (/(^|\.)douyin\.com$/i.test(parsed.hostname) && /^\/video\//.test(parsed.pathname)) return /你浏览的视频不是有效视频|登录后免费畅享高清视频/.test(text || '');
  if (/(^|\.)youtube\.com$/i.test(parsed.hostname) && /\/watch$/i.test(parsed.pathname)) return /此视频无法再播放|视频无法再播放|Video unavailable|This video is unavailable/i.test(text || '');
  if (/(^|\.)weibo\.cn$/i.test(parsed.hostname) && /^\/detail\/\d+/.test(parsed.pathname)) return /该微博不存在|微博不存在|内容不存在/.test(text || '');
  return false;
}
// 中文说明：按最终页面域名标记来源，避免 YouTube、Reddit 和 Gitee 的浏览器结果被错误归为 generic。
function siteForHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value === 'youtube.com' || value.endsWith('.youtube.com') || value === 'youtu.be') return 'youtube';
  if (value === 'reddit.com' || value.endsWith('.reddit.com') || value === 'redd.it') return 'reddit';
  if (value === 'gitee.com' || value.endsWith('.gitee.com')) return 'gitee';
  if (value === 'zhihu.com' || value.endsWith('.zhihu.com')) return 'zhihu';
  if (value === 'xiaohongshu.com' || value.endsWith('.xiaohongshu.com')) return 'xiaohongshu';
  if (value === 'bilibili.com' || value.endsWith('.bilibili.com')) return 'bilibili';
  if (value === 'weibo.com' || value.endsWith('.weibo.com') || value === 'weibo.cn' || value.endsWith('.weibo.cn')) return 'weibo';
  if (value === 'douyin.com' || value.endsWith('.douyin.com')) return 'douyin';
  return 'generic';
}
// 中文说明：抖音搜索被安全验证页拦截时按页面标题和验证资源识别，不把验证码页误报为零结果或选择器失效。
function siteSearchInterruption(site, page = {}) {
  if (site !== 'douyin') return null;
  const title = String(page.title || '');
  const text = String(page.text || '');
  return /验证码中间页|安全验证|安全检查/i.test(title)
    || /请完成验证|拖动滑块|安全验证|验证码/i.test(text)
    || Boolean(page.challengeFrameVisible)
    ? 'site_verification_required' : null;
}
function clientDeviceType(request) {
  const userAgent = String(request.headers['user-agent'] || '');
  const mobileHint = String(request.headers['sec-ch-ua-mobile'] || '');
  // 桌面微信也会带 MicroMessenger，不能仅凭该标记判定手机。
  return mobileHint === '?1' || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(userAgent) ? 'mobile' : 'desktop';
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// 中文说明：记录浏览器实际代理参数，但不保存代理凭据；供 status/doctor 区分代理启动和直连启动。
function browserProxyInfo() {
  const raw = String(process.env.BROWSER_HUB_PROXY || '').trim();
  if (!raw) return { enabled: false, argument: false, protocol: null, endpoint: null };
  try {
    const proxy = new URL(raw);
    return { enabled: true, argument: true, protocol: proxy.protocol.replace(/:$/, ''), endpoint: proxy.origin };
  } catch {
    return { enabled: true, argument: false, protocol: null, endpoint: null, invalid: true };
  }
}
// 中文说明：以原子文件创建保护 Profile；异常退出后只回收确认已不存在的服务锁。
async function acquireProfileLock(profileName) {
  await fs.mkdir(PROFILE_LOCK_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(PROFILE_LOCK_ROOT, 0o700);
  const file = path.join(PROFILE_LOCK_ROOT, `${profileName}.json`);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const metadata = { service: 'browser-hub', pid: process.pid, profile: profileName, nonce, created_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(metadata) + '\n'); }
      finally { await handle.close(); }
      await fs.chmod(file, 0o600);
      return async () => {
        const current = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        if (current?.pid === process.pid && current?.nonce === nonce) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.pid && alive(current.pid)) throw new Error(`Profile ${profileName} 已被 browser-hub 进程 ${current.pid} 使用，请复用现有服务或更换 Profile`);
      await fs.unlink(file).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    }
  }
  throw new Error(`无法取得 Profile ${profileName} 的独占锁，请稍后重试`);
}
async function launch(browser, profile, options) {
  const executable = browser.includes(path.sep) ? path.resolve(browser) : browser;
  const args = ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--window-size=1280,800', '--disk-cache-size=16777216', '--media-cache-size=1048576', STARTUP_PAGE];
  if (options.noSandbox) args.unshift('--no-sandbox');
  if (process.env.BROWSER_HUB_PROXY) {
    const proxy = new URL(process.env.BROWSER_HUB_PROXY);
    if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol)) throw new Error('不支持的浏览器代理协议');
    if (proxy.username || proxy.password) throw new Error('请使用 proxy-tunnel 本地代理，不在浏览器命令行携带代理密码');
    args.unshift(`--proxy-server=${proxy.origin}`);
    // 中文说明：微博登录页、二维码和新浪静态资源在部分代理节点上会被直接断开；仅绕过这些域名，其他站点仍沿用项目代理。
    const bypass = process.env.BROWSER_HUB_PROXY_BYPASS_LIST || '*.weibo.com;*.weibo.cn;*.sinaimg.cn;*.sina.com.cn;*.sina.cn';
    args.unshift(`--proxy-bypass-list=${bypass}`);
  }
  // 中文说明：便携版 macOS 浏览器的资源与可执行文件同目录，固定子进程工作目录，避免调用者位置影响资源定位。
  const browserDirectory = process.platform === 'darwin' && path.isAbsolute(executable) ? path.dirname(executable) : undefined;
  const child = spawn(executable, args, { cwd: browserDirectory, env: browserDirectory ? { ...process.env, PWD: browserDirectory } : process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let buffer = '';
  try {
    const websocket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('浏览器启动超时；Linux 可用 doctor 检查缺失的动态库')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`浏览器退出（${code}）：${buffer.slice(-1200)}`)); });
      child.stderr.on('data', chunk => {
        buffer = (buffer + chunk.toString()).slice(-8000);
        const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const debugOrigin = new URL(websocket).origin.replace('ws:', 'http:');
    // 中文说明：调试端口就绪不代表渲染进程可用；首次启动和崩溃恢复都必须实际完成页面渲染。
    await verifyBrowserPage(debugOrigin, child);
    return { child, websocket, debugOrigin, diagnostics: () => buffer.slice(-2500) };
  } catch (error) {
    // 中文说明：失败后等自建进程退出再释放 Profile 锁，避免下一次启动撞上仍在退出的旧浏览器。
    await stopChild(child);
    const diagnostics = buffer.slice(-2500);
    const hint = process.platform === 'darwin' && /icudtl\.dat|Invalid file descriptor to ICU data/i.test(diagnostics)
      ? '；macOS Chromium 无法加载 ICU 资源，请检查安装完整性及启动终端或 IDE 对浏览器目录的文件访问权限'
      : '';
    throw new Error(`浏览器页面初始化失败：${error.message}${hint}${diagnostics ? '\n' + diagnostics : ''}`, { cause: error });
  }
}

// 中文说明：用启动页的 DOM 就绪和截图验证渲染链路，避免服务对外报告成功后才发现 GPU 或渲染进程已崩溃。
async function verifyBrowserPage(debugOrigin, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('浏览器在页面就绪前退出');
    const response = await fetch(`${debugOrigin}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`浏览器调试接口返回 HTTP ${response.status}`);
    const target = (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) { await delay(100); continue; }
    const client = await Cdp.connect(target.webSocketDebuggerUrl);
    try {
      await client.send('Page.enable');
      const ready = await client.send('Runtime.evaluate', {
        expression: "new Promise(resolve => { if (document.readyState === 'complete') resolve(true); else addEventListener('load', () => resolve(true), { once: true }); })",
        awaitPromise: true, returnByValue: true
      });
      if (ready.exceptionDetails || ready.result?.value !== true) throw new Error('浏览器启动页未能完成加载');
      const frame = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 30 });
      if (!frame.data) throw new Error('浏览器启动页未能生成画面');
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('浏览器在页面就绪前退出');
      return;
    } finally { client.close(); }
  }
  throw new Error('浏览器启动页就绪超时');
}

export async function serve(options = {}) {
  const readSnapshots = new ReadSnapshots(path.join(RUN_ROOT, 'read-snapshots'), 'bh');
  const networkPolicy = policyFromConfig({ networkPolicy: options.networkPolicy || DEFAULT_NETWORK_POLICY });
  async function protectedUrl(value) {
    const url = validUrl(value);
    try { await checkTarget(url, networkPolicy); }
    catch (error) {
      throw new HttpError(error.message, 403, { code: error.code || 'target_blocked', diagnostics: error.diagnostics || { target: url } });
    }
    return url;
  }
  let publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : null;
  if (publicOrigin && !publicOrigin.startsWith('https://')) throw new Error('外部工作台必须使用 HTTPS 地址');
  const profileName = options.profile || 'default';
  const startedAt = new Date().toISOString();
  const sourceMtime = await fs.stat(SERVER_SOURCE).then(stat => stat.mtime.toISOString()).catch(() => null);
  if (!/^[\w-]{1,48}$/.test(profileName)) throw new Error('Profile 名只允许字母、数字、下划线和短横线');
  const previous = await fs.readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.pid && alive(previous.pid)) throw new Error('已有 browser-hub 服务运行，请复用它或先在原终端停止');
  await fs.mkdir(RUN_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(RUN_ROOT, 0o700);
  const profile = path.resolve(PROFILE_ROOT, profileName);
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.chmod(profile, 0o700);
  const browser = await findBrowser(options.browser);
  const releaseProfileLock = await acquireProfileLock(profileName);
  let launched;
  let browserCdp;
  let browserVersion;
  // 中文说明：浏览器空闲时崩溃可以重建 Chromium 和 CDP；读取进行中不重启，避免把半截结果误认为成功。
  let recovering = false;
  let browserRestartCount = 0;
  let lastBrowserRestart = null;
  let lastBrowserError = null;
  async function browserSend(method, params = {}) {
    if (recovering) throw new Error('浏览器正在恢复，请稍后重试');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!browserCdp?.isOpen()) {
        browserCdp?.close();
        browserCdp = await Cdp.connect(launched.websocket);
      }
      try { return await browserCdp.send(method, params); }
      catch (error) {
        const closed = /WebSocket is not open|浏览器连接已关闭|readyState \d+ \(CLOSED\)/i.test(error.message || '');
        if (!closed || attempt === 1) throw error;
        browserCdp.close();
        browserCdp = null;
      }
    }
    throw new Error('浏览器 CDP 重连失败');
  }
  try {
    launched = await launch(browser, profile, options);
    browserCdp = await Cdp.connect(launched.websocket);
    browserVersion = await browserSend('Browser.getVersion');
  } catch (error) {
    browserCdp?.close();
    await stopChild(launched?.child);
    await releaseProfileLock();
    throw error;
  }
  // 可选的轻量反自动化特征兼容：只修改新建 Agent 标签页的公开浏览器标识，不读取或导出登录资料。
  const stealth = options.stealth ?? process.env.BROWSER_HUB_STEALTH !== '0';
  let stealthUserAgent = browserVersion.userAgent?.replace(/HeadlessChrome\//g, 'Chrome/');
  const pageClients = new Map();
  let activeId;
  let busy = false;
  let automationQueueDepth = 0;
  let activeStartedAt = null;
  let rejectedRequestCount = 0;
  let lastQueueRejectedAt = null;
  let lastQueueWaitMs = 0;
  let maxQueueWaitMs = 0;
  let viewport = { width: 1280, height: 800 };
  let closing = false;
  const token = crypto.randomBytes(32).toString('base64url');
  let baseUrl;
  async function writeState() {
    const state = { service: 'browser-hub', pid: process.pid, browser_pid: launched.child.pid, base_url: baseUrl, public_url: publicOrigin, token, profile: profileName, profile_lock: path.join(PROFILE_LOCK_ROOT, `${profileName}.json`), browser, browser_proxy: browserProxyInfo(), network_policy: { mode: networkPolicy.mode, allowed_hosts: networkPolicy.allowedHosts, resolve_dns: networkPolicy.resolveDns }, tunnel_mode: options.tunnel?.mode || null, started_at: startedAt, source_mtime: sourceMtime, browser_version: browserVersion.product || null };
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, STATE_FILE);
    await fs.chmod(STATE_FILE, 0o600);
  }
  async function updatePublicOrigin(url) {
    const next = new URL(url).origin;
    if (!next.startsWith('https://') || next === publicOrigin) return;
    publicOrigin = next;
    await writeState();
    console.log(`公网隧道地址已更新，请重新运行 browser-hub link 获取新链接：${publicOrigin}`);
  }
  async function tabs() {
    const response = await fetch(`${launched.debugOrigin}/json/list`);
    const pages = (await response.json()).filter(tab => tab.type === 'page');
    const pageIds = new Set(pages.map(tab => tab.id));
    for (const [id, client] of pageClients) {
      if (!pageIds.has(id)) { client.close(); pageClients.delete(id); }
    }
    if (!pages.some(tab => tab.id === activeId)) activeId = pages[0]?.id;
    return pages;
  }
  async function page(id) {
    const tab = (await tabs()).find(item => item.id === (id || activeId));
    if (!tab) throw new Error('没有可操作的标签页');
    const previousClient = pageClients.get(tab.id);
    if (previousClient && !previousClient.isOpen()) {
      previousClient.close();
      pageClients.delete(tab.id);
    }
    if (!pageClients.has(tab.id)) {
      const client = await Cdp.connect(tab.webSocketDebuggerUrl);
      await client.send('Page.enable');
      // 中文说明：只拦截顶层文档请求，防止导航或重定向把浏览器带到本机/私网；普通图片、脚本和 WebSocket 仍由 Chromium 正常加载。
      const guardDocument = async data => {
        let event;
        try { event = JSON.parse(data.toString()); } catch { return; }
        if (event.method !== 'Fetch.requestPaused') return;
        const params = event.params || {};
        if (!isDocumentRequestType(params.resourceType)) {
          await client.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
          return;
        }
        try {
          await checkTarget(params.request?.url, networkPolicy);
          await client.send('Fetch.continueRequest', { requestId: params.requestId });
        } catch (error) {
          await client.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      };
      client.socket.on('message', guardDocument);
      await client.send('Fetch.enable', { patterns: [{ requestStage: 'Request', resourceType: 'Document' }] });
      await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
      if (stealth) {
        await client.send('Network.enable');
        if (stealthUserAgent) await client.send('Network.setUserAgentOverride', { userAgent: stealthUserAgent, acceptLanguage: 'zh-CN,zh;q=0.9' });
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });" });
      }
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: HORIZONTAL_LAYOUT_FIX });
      pageClients.set(tab.id, client);
    }
    return pageClients.get(tab.id);
  }
  // 中文说明：只根据当前标签页的地址、标题和少量界面标记判断登录阶段，不读取或返回 Cookie、令牌和正文。
  async function loginStatus(tab) {
    if (!tab) return { state: 'no_page', label: '没有活动页面' };
    if (/^chrome-error:/i.test(tab.url || '')) return { state: 'page_error', label: '网页加载失败', url: tab.url };
    const parsed = new URL(tab.url);
    const host = parsed.hostname.toLowerCase();
    const site = /(^|\.)weibo\.(com|cn)$/.test(host) || /(^|\.)sina\.(com\.cn|cn)$/.test(host) || /(^|\.)passport\.weibo\.com$/.test(host) ? 'weibo'
      : /(^|\.)douyin\.com$/.test(host) ? 'douyin'
      : /(^|\.)bilibili\.com$/.test(host) ? 'bilibili'
      : /(^|\.)zhihu\.com$/.test(host) ? 'zhihu'
      : /(^|\.)xiaohongshu\.com$/.test(host) ? 'xiaohongshu' : null;
    if (!site) return { state: 'unknown', label: '未识别站点', url: tab.url };
    let observation;
    try {
      observation = await evaluate(await page(tab.id), `(() => ({ title: document.title || '', text: (document.body?.innerText || '').slice(0, 5000), ready: document.readyState }))()`);
    } catch (error) {
      return { site, state: 'unavailable', label: '页面状态暂时不可读取', url: tab.url, error: error.message };
    }
    const text = String(observation?.text || '');
    const title = String(observation?.title || '');
    const pending = /成功扫描|请在手机.*确认|点击确认.*登录|已扫描二维码/i.test(text);
    const required = /登录|注册|扫码登录|验证码登录|账号登录/i.test(text) || /passport|signin|login/i.test(`${host}${parsed.pathname}`);
    let loggedIn = false;
    if (site === 'weibo') loggedIn = (/m\.weibo\.cn|weibo\.cn/.test(host) && /关注[\s\S]{0,120}热门/.test(text) && !required) || (/我的新浪|我的新闻/.test(`${title}\n${text}`) && !required);
    if (site === 'douyin') loggedIn = /我的|关注|个人主页/.test(text) && !required && !/登录注册|扫码登录/.test(text);
    if (site === 'bilibili') loggedIn = /大会员|消息|动态/.test(text) && !required;
    if (site === 'zhihu') loggedIn = /首页|回答|写回答/.test(text) && !required;
    if (site === 'xiaohongshu') loggedIn = /发现|关注|我的/.test(text) && !required;
    const state = pending ? 'pending_confirmation' : loggedIn ? 'logged_in' : required ? 'login_required' : observation?.ready === 'complete' ? 'unknown' : 'loading';
    const labels = { logged_in: '已登录', pending_confirmation: '已扫码，等待手机确认', login_required: '需要登录', loading: '页面加载中', unknown: '尚未确认登录状态' };
    return { site, state, label: labels[state] || state, url: tab.url, title };
  }
  async function newTab(url) {
    const { targetId } = await browserSend('Target.createTarget', { url, background: true });
    return targetId;
  }
  // 中文说明：重启只替换浏览器进程，继续复用同一个 Profile、服务令牌和 HTTP 端口。
  async function recoverBrowser(reason) {
    if (closing || recovering) return;
    recovering = true;
    lastBrowserError = reason;
    console.error(`浏览器意外退出，正在恢复空闲会话：${reason}`);
    for (const client of pageClients.values()) client.close();
    pageClients.clear();
    activeId = null;
    browserCdp?.close();
    browserCdp = null;
    let replacement;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let replacementCdp;
        try {
          replacement = await launch(browser, profile, options);
          replacementCdp = await Cdp.connect(replacement.websocket);
          const replacementVersion = await replacementCdp.send('Browser.getVersion');
          launched = replacement;
          browserCdp = replacementCdp;
          browserVersion = replacementVersion;
          stealthUserAgent = browserVersion.userAgent?.replace(/HeadlessChrome\//g, 'Chrome/');
          const created = await browserCdp.send('Target.createTarget', { url: STARTUP_PAGE, background: true });
          activeId = created.targetId;
          browserRestartCount += 1;
          lastBrowserRestart = new Date().toISOString();
          lastBrowserError = null;
          recovering = false;
          await writeState();
          watchBrowser(replacement.child);
          console.error(`浏览器已恢复，新的浏览器进程 PID：${replacement.child.pid}`);
          return;
        } catch (error) {
          replacementCdp?.close();
          await stopChild(replacement?.child);
          replacement = null;
          lastBrowserError = error.message;
          if (attempt < 2) await delay(1000);
        }
      }
      throw new Error(lastBrowserError || '浏览器重启失败');
    } catch (error) {
      recovering = false;
      lastBrowserError = error.message;
      console.error(`浏览器自动恢复失败，服务将停止：${error.message}`);
      await shutdown();
    }
  }
  function watchBrowser(child) {
    child.once('exit', (code, signal) => {
      if (closing || child !== launched.child) return;
      const reason = `code=${code} signal=${signal || '无'}；${launched.diagnostics()}`;
      if (!busy && automationQueueDepth === 0) void recoverBrowser(reason);
      else {
        lastBrowserError = reason;
        console.error(`浏览器意外退出且当前有 Agent 请求，服务将停止：${reason}`);
        void shutdown().catch(console.error);
      }
    });
  }
  async function evaluate(client, expression) {
    const output = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (output.exceptionDetails) {
      const detail = output.exceptionDetails.exception?.description || output.exceptionDetails.text || '未知脚本错误';
      throw new Error(`网页读取脚本执行失败：${detail.slice(0, 500)}`);
    }
    return output.result.value;
  }
  async function scrollMetrics(client, point = {}) {
    const pointX = Number.isFinite(Number(point.x)) ? Number(point.x) : null;
    const pointY = Number.isFinite(Number(point.y)) ? Number(point.y) : null;
    return evaluate(client, `(() => {
      const root = document.scrollingElement || document.documentElement;
      let target = root;
      let node = document.elementFromPoint(${pointX === null ? 'window.innerWidth / 2' : JSON.stringify(pointX)}, ${pointY === null ? 'window.innerHeight / 2' : JSON.stringify(pointY)});
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        const vertical = node.scrollHeight - node.clientHeight > 1 && /auto|scroll|overlay/.test(style.overflowY);
        const horizontal = node.scrollWidth - node.clientWidth > 1 && /auto|scroll|overlay/.test(style.overflowX);
        if (vertical || horizontal) { target = node; break; }
        node = node.parentElement;
      }
      const height = target.scrollHeight || 0;
      const viewport = target.clientHeight || window.innerHeight || 0;
      const width = target.scrollWidth || 0;
      const viewportWidth = target.clientWidth || window.innerWidth || 0;
      return { top: Math.max(0, target.scrollTop || 0), left: Math.max(0, target.scrollLeft || 0), height, viewport, maxTop: Math.max(0, height - viewport), width, viewportWidth, maxLeft: Math.max(0, width - viewportWidth) };
    })()`);
  }
  async function scrollAt(client, deltaX, deltaY, point = {}) {
    const pointX = Number.isFinite(Number(point.x)) ? Number(point.x) : null;
    const pointY = Number.isFinite(Number(point.y)) ? Number(point.y) : null;
    return evaluate(client, `(() => {
      const root = document.scrollingElement || document.documentElement;
      let target = root;
      let node = document.elementFromPoint(${pointX === null ? 'window.innerWidth / 2' : JSON.stringify(pointX)}, ${pointY === null ? 'window.innerHeight / 2' : JSON.stringify(pointY)});
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        const vertical = node.scrollHeight - node.clientHeight > 1 && /auto|scroll|overlay/.test(style.overflowY);
        const horizontal = node.scrollWidth - node.clientWidth > 1 && /auto|scroll|overlay/.test(style.overflowX);
        if (vertical || horizontal) { target = node; break; }
        node = node.parentElement;
      }
      target.scrollLeft += ${JSON.stringify(deltaX)};
      target.scrollTop += ${JSON.stringify(deltaY)};
    })()`);
  }
  async function automate(body, searchMode) {
    if (busy) throw new Error('浏览器正在处理另一个 Agent 请求，请稍后重试');
    const source = searchMode ? SITE_SEARCH[body.source] : null;
    if (searchMode && !source) throw new Error(`当前浏览器搜索尚未适配 ${body.source}`);
    const url = await protectedUrl(searchMode ? source.url(encodeURIComponent(body.query || '')) : body.url);
    busy = true;
    activeStartedAt = Date.now();
    let id;
    let structuredReady = false;
    let extractionDiagnostic = null;
    let navigationStatus = null;
    let attempts = 0;
    let preserveActivePage = false;
    const startedAt = Date.now();
    try {
      // 用户刚在工作台完成验证码时，复用同一查询标签，避免新标签再次触发站点验证。
      if (searchMode) {
        const current = (await tabs()).find(tab => tab.id === activeId);
        try { preserveActivePage = Boolean(current && new URL(current.url).href === new URL(url).href); } catch { preserveActivePage = false; }
      }
      // 普通请求使用独立标签；已验证且 URL 相同的站内搜索复用工作台当前标签。
      id = preserveActivePage ? activeId : await newTab(STARTUP_PAGE);
      const client = await page(id);
      const frame = (await client.send('Page.getFrameTree')).frameTree.frame.id;
      await client.send('Network.enable');
      client.socket.on('message', data => {
        const event = JSON.parse(data.toString());
        if (event.method === 'Network.responseReceived' && event.params.type === 'Document' && event.params.frameId === frame) navigationStatus = event.params.response.status;
      });
      if (!preserveActivePage) {
        // 中文说明：清单查询仅借用B站源站与登录会话，不加载视频页播放器，避免站点自动请求媒体或字幕。
        const navigation = await client.send('Page.navigate', { url: body.list_tracks ? 'https://www.bilibili.com/robots.txt' : url });
        if (navigation.errorText) throw new HttpError(`浏览器导航失败：${navigation.errorText}`, 502, { code: 'browser_navigation_failed' });
      }
      let value;
      for (let attempt = 0; attempt < AUTOMATION_POLL_ATTEMPTS; attempt++) {
        attempts = attempt + 1;
        // 中文说明：导航命令已返回后先立即检查一次；只有页面仍在加载时才等待下一轮，减少静态页和结构化页面的固定 250 毫秒延迟。
        if (attempt > 0) await delay(AUTOMATION_POLL_INTERVAL);
        if (searchMode) {
          value = await evaluate(client, body.source === 'bilibili' ? BILIBILI_SEARCH : body.source === 'weibo' ? WEIBO_SEARCH.replace('__LIMIT__', JSON.stringify(Math.max(1, Math.min(Number(body.limit) || 10, 50)))) : body.source === 'douyin' ? DOUYIN_SEARCH.replace('__LIMIT__', JSON.stringify(Math.max(1, Math.min(Number(body.limit) || 10, 50)))) : `(() => {
            const seen = new Set();
            return [...document.querySelectorAll(${JSON.stringify(source.links)})].map(a => {
              const card = a.closest('section,article,[class*="card"],[class*="Card"],.ContentItem') || a.parentElement;
              return { title: (a.innerText || a.getAttribute('title') || a.querySelector('img')?.alt || card?.innerText || '').trim().slice(0,240),
                url: a.href, summary: (card?.innerText || a.innerText || '').trim().slice(0,1200) };
            }).filter(item => item.title && /^https?:/.test(item.url) && !seen.has(item.url) && seen.add(item.url)).slice(0,${Math.max(1, Math.min(Number(body.limit) || 10, 50))});
          })()`);
          if (value?.length) break;
        } else {
          value = await evaluate(client, `(() => {
            const root = document.querySelector('article,main') || document.body;
            const metadata = ${PAGE_METADATA};
            return { title: document.title, url: location.href, text: root?.innerText || '', html: ${JSON.stringify(body.format === 'markdown')} ? root?.outerHTML || '' : null, metadata, ready: document.readyState };
          })()`);
          const pageReady = value?.ready === 'complete';
          const hostname = new URL(value?.url || url).hostname;
          if (/(^|\.)bilibili\.com$/i.test(hostname)) {
            const structured = await evaluate(client, `(${BILIBILI_READ})(${JSON.stringify({ pages: body.pages, subtitle_language: body.subtitle_language, compact: body.compact, timestamps: body.timestamps, start_seconds: body.start_seconds, end_seconds: body.end_seconds, list_tracks: body.list_tracks, ...(body.list_tracks ? { bvid: new URL(url).pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)[1], url_page: new URL(url).searchParams.get('p') } : {}) })})`);
            if (structured?.request_error) throw new HttpError(structured.request_error.message, 400, { code: structured.request_error.code });
            if (body.list_tracks) {
              if (!structured?.bilibili_catalog) throw new HttpError('B站轨道清单查询失败，不能据此断言没有字幕', 502, { code: 'bilibili_catalog_failed', diagnostics: { site: 'bilibili', reason: structured?.diagnostic_code, api_code: structured?.api_code, api_status: structured?.api_status } });
              const { ready, bilibili_catalog, ...catalog } = structured;
              return { ...catalog, url, retrieved_at: new Date().toISOString(), diagnostics: { site: 'bilibili', extraction: 'track_metadata_only' } };
            }
            if (structured?.ready) {
              structuredReady = true;
              extractionDiagnostic = structured.diagnostic_code || null;
              const hydrated = await hydrateBilibiliSubtitle(structured, networkPolicy);
              value = { ...value, ...hydrated, metadata: { author: hydrated.author, published_at: hydrated.published_at, stats: hydrated.stats } };
            } else if (structured?.diagnostic_code) extractionDiagnostic = structured.diagnostic_code;
          } else if (/(^|\.)zhihu\.com$/i.test(hostname)) {
            const structured = await evaluate(client, `(${ZHIHU_READ})()`);
            if (structured?.ready) {
              structuredReady = true;
              extractionDiagnostic = structured.diagnostic_code || null;
              value = { ...value, ...structured, metadata: { author: structured.author, published_at: structured.published_at, stats: structured.stats } };
            } else if (structured?.diagnostic_code) extractionDiagnostic = structured.diagnostic_code;
          } else if (/(^|\.)xiaohongshu\.com$/i.test(hostname)) {
            const structured = await evaluate(client, `(${XIAOHONGSHU_READ})()`);
            if (structured?.ready) {
              structuredReady = true;
              extractionDiagnostic = structured.diagnostic_code || null;
              value = { ...value, ...structured, metadata: { author: structured.author, published_at: structured.published_at, stats: structured.stats } };
            } else if (structured?.diagnostic_code) extractionDiagnostic = structured.diagnostic_code;
          } else if (/(^|\.)weibo\.cn$/i.test(hostname)) {
            const structured = await evaluate(client, `(${WEIBO_READ})()`);
            if (structured?.ready) {
              structuredReady = true;
              extractionDiagnostic = structured.diagnostic_code || null;
              value = { ...value, ...structured, metadata: { author: structured.author, published_at: structured.published_at, stats: structured.stats } };
            } else if (structured?.diagnostic_code) extractionDiagnostic = structured.diagnostic_code;
          } else if (/(^|\.)douyin\.com$/i.test(hostname) && /^\/video\/\d+/i.test(new URL(value?.url || url).pathname)) {
            const structured = await evaluate(client, DOUYIN_READ);
            if (structured?.ready) {
              structuredReady = true;
              extractionDiagnostic = structured.diagnostic_code || null;
              value = { ...value, ...structured, metadata: { author: structured.author, published_at: structured.published_at, stats: structured.stats } };
            } else if (structured?.diagnostic_code) extractionDiagnostic = structured.diagnostic_code;
          }
          const pending = detailContentPending(url, value?.text);
          if (pending) extractionDiagnostic = 'site_content_loading';
          else if (extractionDiagnostic === 'site_content_loading') extractionDiagnostic = null;
          if (structuredReady || (!body.list_tracks && pageReady && !pending && (value.text.length > 100 || navigationStatus >= 400))) break;
        }
      }
      if (body.list_tracks) throw new HttpError('B站清单查询未能建立源站页面，请检查网络与浏览器服务', 502, { code: 'bilibili_catalog_failed' });
      if (searchMode) {
        if (!value?.length && navigationStatus >= 400) {
          const page = await evaluate(client, `(() => ({ title: document.title || '', url: location.href }))()`);
          throw new HttpError(`${body.source} 搜索页面返回 HTTP ${navigationStatus}，未取得站内条目`, navigationStatus, {
            code: 'site_search_http_error',
            diagnostics: { site: body.source, http_status: navigationStatus, search_url: page?.url || url, page_title: page?.title || null, reason: navigationStatus === 403 ? 'access_restricted' : 'search_http_error' }
          });
        }
        if (!value?.length && body.source === 'douyin') {
          const page = await evaluate(client, `(() => {
            const challengeFrameVisible = [...document.querySelectorAll('iframe[src]')].some(frame => {
              if (!/captcha|verifycenter/i.test(frame.src || '')) return false;
              const rect = frame.getBoundingClientRect();
              const style = getComputedStyle(frame);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            });
            return { title: document.title || '', text: (document.body?.innerText || '').slice(0, 1600), challengeFrameVisible };
          })()`);
          if (siteSearchInterruption(body.source, page)) {
            throw new HttpError('抖音搜索被站点验证码拦截；请在 browser-hub 工作台人工完成验证后再重试。', 409, { code: 'site_verification_required' });
          }
        }
        if (!value?.length) {
          const page = await evaluate(client, `(() => ({ title: document.title || '', url: location.href }))()`);
          throw new HttpError('未获取到搜索条目，可能需要登录、验证码或站点适配更新；请在工作台打开该站点检查', 502, {
            code: 'site_search_no_results',
            diagnostics: { site: body.source, http_status: navigationStatus, search_url: page?.url || url, page_title: page?.title || null, reason: 'no_matching_cards' }
          });
        }
        const requestedLimit = Math.max(1, Math.min(Number(body.limit) || 10, 50));
        value = value.slice(0, requestedLimit);
        return { source: body.source, results: value, result_count: value.length, elapsed_ms: Date.now() - startedAt, content_status: 'summary', warnings: ['页面可见条目；不保证完整站内索引或全部评论'], retrieved_at: new Date().toISOString() };
      }
      const limit = Math.max(200, Math.min(Number(body.max_chars) || 8000, 50000));
      const finalUrl = value?.url || url;
      try { await checkTarget(finalUrl, networkPolicy); }
      catch (error) {
        throw new HttpError(error.message, 403, { code: error.code || 'redirect_target_blocked', diagnostics: { ...(error.diagnostics || {}), original_url: url, final_url: finalUrl } });
      }
      const navigationUnavailable = detailNavigationUnavailable(url, finalUrl);
      const unavailableText = `${value?.title || ''}\n${value?.text || ''}`;
      const detailUnavailable = detailContentUnavailable(url, value?.text);
      const unavailable = navigationStatus >= 400 || detailUnavailable || extractionDiagnostic === 'site_content_loading' || navigationUnavailable || Boolean(value?.site_unavailable) || /页面不见了|页面不存在|当前笔记暂时无法浏览|内容不存在|请打开小红书App扫码查看|小红书\s*[-|｜]\s*你的生活兴趣社区|登录知乎|注册登录/i.test(unavailableText)
        || (Boolean(extractionDiagnostic) && !String(value?.text || '').trim());
      const metadata = value?.metadata || {};
      const missingFields = [
        !metadata.author && 'author',
        !metadata.published_at && 'published_at',
        !metadata.stats && 'stats'
      ].filter(Boolean);
      let content = value?.text || '';
      if (body.format === 'markdown' && value?.zhihu_initial_data) {
        content = [value.title ? '# ' + value.title : '', value.author ? '作者：' + value.author : '', htmlToMarkdown(value.body_html || '', finalUrl, MODULE_ROOT)].filter(Boolean).join('\n\n');
      } else if (body.format === 'markdown' && value?.html && !value?.bilibili_api && !value?.xiaohongshu_initial_state && !value?.douyin_metadata) {
        content = htmlToMarkdown(value.html, finalUrl, MODULE_ROOT);
      }
      const sourceTruncated = Boolean(value?.source_content_truncated);
      const window = contentWindow(content, limit, body.offset, sourceTruncated);
      const structuredStatus = value?.bilibili_api ? (value.subtitle ? 'api_structured' : 'api_metadata') : value?.douyin_metadata ? 'site_structured' : value?.question_without_answer ? 'question_metadata' : value?.zhihu_initial_data || value?.xiaohongshu_initial_state || value?.weibo_mobile ? 'site_structured' : 'browser_text';
      const missing = [...missingFields];
      if (value?.bilibili_api && !value.subtitle && value.subtitle_status !== 'no_match') missing.push('subtitle');
      if (value?.subtitle && (value.subtitle_page_count < value.subtitle_selection.pages.length || (value.subtitle_selection.mode === 'default' && value.subtitle_selection.unrequested_page_count))) missing.push('subtitle_pages');
      if (value?.xiaohongshu_initial_state && value.body_text_missing) missing.push('body_text');
      if (value?.zhihu_initial_data && value.body_text_missing) missing.push('body_text');
      if (value?.weibo_mobile && value.body_text_missing) missing.push('body_text');
      if (value?.question_without_answer) missing.push('answer_content');
      const warning = unavailable ? '站点返回页面不存在或暂时不可浏览；可能需要结果链接中的会话参数、登录或站点风控' : value?.bilibili_api ? '已通过 B 站同源接口读取视频结构化信息；字幕是否存在取决于视频和当前会话' : value?.douyin_metadata ? '已读取抖音页面 meta description 中的作品文案和元数据；未取得视频画面、音频或字幕正文' : value?.question_without_answer ? '这是知乎问题页的描述和元数据；未指定具体回答，因此没有回答正文' : value?.zhihu_initial_data ? '已从知乎页面初始数据读取文章或回答正文；页面仍可能受登录和内容权限影响' : value?.xiaohongshu_initial_state ? (value.body_text_missing ? '已读取小红书元数据和图片清单；当前站点初始数据中的文案为空，保留 body_text 缺失标记；图片内容未做 OCR' : '已从小红书页面初始数据读取笔记正文和互动字段；图片内容未做 OCR') : value?.weibo_mobile ? '已从微博移动详情页读取正文和作者时间；评论区不计入正文，图片仅返回索引' : '仅提取当前页面可见文本；可能包含登录提示或未展开内容';
      if (sourceTruncated) missing.push('content_tail');
      if (value?.subtitle_timing?.missing_time_count) missing.push('subtitle_timestamps');
      const hostname = (() => { try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return ''; } })();
      const site = siteForHostname(hostname);
      const diagnostics = {
        site,
        http_status: navigationStatus,
        attempts,
        redirected: finalUrl !== url,
        extraction: structuredStatus,
        extraction_diagnostic: extractionDiagnostic || value?.diagnostic_code || null,
        question_without_answer: Boolean(value?.question_without_answer),
        answer_count: value?.answer_count ?? null,
        body_is_excerpt: Boolean(value?.body_is_excerpt),
        subtitle_status: value?.subtitle_status || null,
        subtitle_server_fallback: Boolean(value?.subtitle_server_fallback),
        subtitle_failure_count: value?.subtitle_failure_count ?? 0,
        subtitle_failures: value?.subtitle_failures || [],
        subtitle_page_count: value?.subtitle_page_count ?? null,
        subtitle_track_count: value?.subtitle_track_count ?? null,
        page_count: value?.page_count ?? null,
        body_text_missing: Boolean(value?.body_text_missing),
        unavailable_reason: unavailable ? (navigationStatus >= 400 ? `http_${navigationStatus}` : navigationUnavailable ? 'detail_navigation_changed' : detailUnavailable ? 'detail_content_unavailable' : extractionDiagnostic || value?.diagnostic_code || 'site_blocked_or_login') : null
      };
      const output = { title: value?.title || null, url: finalUrl, content: window.content, content_window: window.content_window, content_format: readFormat(body.format),
        ...(body.compact ? { response_mode: 'compact' } : {}),
        ...(unavailable ? { error: { code: 'not_found_or_blocked', ...(navigationStatus >= 400 ? { status: navigationStatus } : {}), recovery: recoveryFor({ code: 'not_found_or_blocked', status: navigationStatus }) } } : {}),
        content_status: unavailable ? 'not_found_or_blocked' : structuredStatus, truncated: window.content_window.has_more,
        author: metadata.author || null, published_at: metadata.published_at || null, stats: metadata.stats || null,
        subtitle: value?.subtitle || null, subtitle_status: value?.subtitle_status || null, ...(value?.bilibili_api ? { subtitle_pages: value.subtitle_pages, subtitle_selection: value.subtitle_selection, ...(value.subtitle_timing ? { subtitle_timing: value.subtitle_timing, subtitle_cues: value.subtitle_cues } : {}) } : {}), subtitle_page_count: value?.subtitle_page_count ?? null, subtitle_failure_count: value?.subtitle_failure_count ?? 0, media_count: value?.media_count || 0, note_type: value?.note_type || null, missing_fields: [...new Set(missing)], warnings: [warning, value?.subtitle_timing ? '字幕时间为各分P内的原始秒数；区间返回重叠整句，跳转链接向下取整到秒，字幕不代表视频画面全部信息' : null, value?.subtitle_timing?.missing_time_count ? '部分字幕缺少有效时间；无范围时保留文字，按时间筛选时排除并标明缺失' : null, value?.subtitle_status === 'no_match' ? '已读取字幕轨道，但所选时间范围没有可定位的匹配字幕' : null, value?.subtitle_selection?.mode !== 'default' && value?.subtitle_selection?.unrequested_page_count ? '本次仅请求选定分P，字幕可用状态只描述该范围，不代表整套视频' : null, value?.subtitle_pages?.some(p => p.status === 'language_unavailable') ? '所选语言没有可用轨道；未改用其他语言，请检查 subtitle_pages.available_languages' : null, value?.body_is_excerpt ? '知乎当前只提供摘要，不应当视为完整正文' : null, sourceTruncated ? (value?.bilibili_api ? '部分分P字幕不可用，或达到页数/字符上限；不能视为全部字幕' : '站点标记正文可能仍有后续内容') : null].filter(Boolean), diagnostics, retrieved_at: new Date().toISOString() };
      if (value?.xiaohongshu_initial_state || value?.weibo_mobile) {
        output.images = value.images || [];
      }
      let result = output;
      try {
        const record = await readSnapshots.save({ ...output, content, source_truncated: sourceTruncated }, { url, source: body.source || site, format: body.format });
        if (record) result = snapshotWindow(record, { maxChars: limit, offset: body.offset });
      } catch (error) { output.warnings.push(`正文快照未保存：${error.message}`); }
      if (result.subtitle_cues && !result.snapshot) result.subtitle_cues = result.subtitle_cues.filter(cue => cue.range.end > window.content_window.offset && cue.range.start < window.content_window.offset + window.content.length);
      return await withImageDownloads(compactResult(result, body.compact), body);
    } finally {
        if (id && !preserveActivePage) {
        pageClients.get(id)?.close(); pageClients.delete(id);
        await browserSend('Target.closeTarget', { targetId: id }).catch(() => {});
      }
      busy = false;
      activeStartedAt = null;
    }
  }
  // 中文说明：服务端统一串行化 Agent 的搜索和阅读请求，避免多个 CLI/MCP 进程同时访问时互相返回 409 busy。
  let automationQueue = Promise.resolve();
  async function withImageDownloads(result, body) {
    if (body.download_images) {
      const images = selectImages(result.images || [], body.image_indexes);
      let decoderId, decoder;
      const decodeImage = async (data, contentType) => {
        if (!decoderId) decoderId = await newTab('about:blank');
        if (!decoder) decoder = await page(decoderId);
        return evaluate(decoder, `(async () => {
          try {
            const bytes = Uint8Array.from(atob(${JSON.stringify(data.toString('base64'))}), c => c.charCodeAt(0));
            const image = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(contentType)} }));
            const size = { width: image.width, height: image.height };
            image.close();
            return size;
          } catch { return null; }
        })()`);
      };
      let files;
      try { files = await downloadImages(images, body.download_images, decodeImage, networkPolicy); }
      finally {
        if (decoderId) {
          pageClients.get(decoderId)?.close(); pageClients.delete(decoderId);
          await browserSend('Target.closeTarget', { targetId: decoderId }).catch(() => {});
        }
      }
      result.image_download = { directory: files.directory, downloaded: files.downloaded, errors: files.errors };
      if (files.errors.length) result.warnings = [...(result.warnings || []), `有 ${files.errors.length} 张图片下载失败；详见 image_download.errors`];
      const mismatched = files.downloaded.filter(file => file.manifest_dimensions_match === false).length;
      const undecoded = files.downloaded.filter(file => !file.decoded).length;
      if (mismatched) result.warnings = [...(result.warnings || []), `有 ${mismatched} 张图片的实际尺寸与站点清单不同；请查看 actual_width/actual_height，不能据清单尺寸认定为原图`];
      if (undecoded) result.warnings = [...(result.warnings || []), `有 ${undecoded} 张图片已保存但无法确认实际尺寸；详见 image_download.downloaded[].decode_error`];
    }
    return result;
  }
  async function queuedAutomate(body, searchMode) {
    if (!searchMode) {
      body = { ...body, offset: body.offset === undefined ? undefined : readOffset(body.offset) };
      try {
        if (body.format !== undefined) readFormat(body.format);
        body.pages = videoPages(body.pages);
        body.subtitle_language = subtitleLanguage(body.subtitle_language);
        compactMode(body.compact);
        const timing = subtitleTimeline({ url: body.url, source: body.source, timestamps: body.timestamps, startSeconds: body.start_seconds, endSeconds: body.end_seconds });
        Object.assign(body, { timestamps: timing.timestamps, start_seconds: timing.startSeconds, end_seconds: timing.endSeconds });
        listTracksMode(body.list_tracks, { url: body.url, source: body.source, snapshotId: body.snapshot_id, find: body.find, exportDirectory: body.export_directory, downloadImages: body.download_images, imageIndexes: body.image_indexes, subtitleLanguage: body.subtitle_language, compact: body.compact, lean: body.lean, timestamps: body.timestamps, startSeconds: body.start_seconds, endSeconds: body.end_seconds, format: body.format, offset: body.offset });
        readLean(body.lean, { snapshotId: body.snapshot_id, compact: body.compact, find: body.find, exportDirectory: body.export_directory, downloadImages: body.download_images });
        outlineMode(body.outline, { snapshotId: body.snapshot_id, find: body.find, exportDirectory: body.export_directory, downloadImages: body.download_images, lean: body.lean, listTracks: body.list_tracks });
        body.section_start = sectionMode(body.section_start, { snapshotId: body.snapshot_id, outline: body.outline, find: body.find, exportDirectory: body.export_directory, downloadImages: body.download_images, listTracks: body.list_tracks });
        if ((body.pages || body.subtitle_language) && !/(^|\.)bilibili\.com$/i.test(new URL(body.url).hostname)) throw new Error('pages 和 subtitle_language 仅适用于B站视频');
        imageIndexes(body.image_indexes);
        if ((body.find !== undefined || body.export_directory !== undefined) && !body.snapshot_id) throw new Error('find 和快照导出需要 snapshot_id');
        if (body.image_indexes !== undefined && !body.download_images) throw new Error('image_indexes 需要同时提供 download_images 目录');
        if (body.snapshot_id) {
          const record = await readSnapshots.load(body.snapshot_id, { url: body.url, source: body.source, format: body.format, pages: body.pages, subtitleLanguage: body.subtitle_language, timestamps: body.timestamps, startSeconds: body.start_seconds, endSeconds: body.end_seconds });
          return await withImageDownloads(await snapshotResult(record, { maxChars: body.max_chars, offset: body.offset, find: body.find, outline: body.outline, sectionStart: body.section_start, exportDirectory: body.export_directory, compact: body.compact, lean: body.lean }, PROJECT_ROOT), body);
        }
      } catch (error) { throw new HttpError(error.message, 400, { code: error.code || 'invalid_read_options' }); }
    }
    if (automationQueueDepth >= AUTOMATION_QUEUE_LIMIT) {
      rejectedRequestCount += 1;
      lastQueueRejectedAt = new Date().toISOString();
      throw new HttpError('浏览器读取队列已满，请稍后重试', 429, { code: 'browser_adapter_busy', retry_after: 3 });
    }
    const queuedAt = Date.now();
    const position = automationQueueDepth;
    automationQueueDepth += 1;
    const previous = automationQueue;
    let release;
    automationQueue = new Promise(resolve => { release = resolve; });
    await previous;
    const queueWaitMs = Date.now() - queuedAt;
    lastQueueWaitMs = queueWaitMs;
    maxQueueWaitMs = Math.max(maxQueueWaitMs, queueWaitMs);
    try {
      const result = await automate(body, searchMode);
      if (result && typeof result === 'object') {
        result.diagnostics = { ...(result.diagnostics || {}), browser_queue: { position, wait_ms: queueWaitMs } };
      }
      return result;
    }
    finally { automationQueueDepth -= 1; release(); }
  }
  const server = http.createServer(async (request, response) => {
    const json = (value, status = 200) => {
      const payload = value && typeof value === 'object' && !Array.isArray(value) && value.schema_version === undefined ? { schema_version: 1, ...value } : value;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload));
    };
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; frame-ancestors 'none'");
    try {
      const allowedOrigins = [baseUrl, baseUrl.replace('127.0.0.1', 'localhost'), publicOrigin].filter(Boolean);
      const allowedHosts = allowedOrigins.map(origin => new URL(origin).host);
      if (!allowedHosts.includes(request.headers.host)) return json({ error: '无效 Host；请使用 SSH 转发或已配置的 HTTPS 工作台地址' }, 403);
      const url = new URL(request.url, baseUrl);
      if (!url.pathname.startsWith('/api/')) {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const file = files[url.pathname];
        if (!file || request.method !== 'GET') return json({ error: '不存在的页面' }, 404);
        response.setHeader('content-type', `${file[1]}; charset=utf-8`);
        return response.end(await fs.readFile(path.join(TOOL_ROOT, 'web', file[0])));
      }
      const actual = Buffer.from(request.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return json({ error: '需要接管令牌' }, 401);
      if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) return json({ error: '不允许跨站操作' }, 403);
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const pages = recovering ? [] : await tabs().catch(() => []);
        const activeTab = pages.find(tab => tab.id === activeId) || pages[0];
        const login = recovering ? { state: 'browser_recovering', label: '浏览器恢复中' } : await loginStatus(activeTab);
        return json({ busy, active: busy, active_elapsed_ms: activeStartedAt ? Date.now() - activeStartedAt : 0, queued: Math.max(0, automationQueueDepth - Number(busy)), in_flight: automationQueueDepth, queue_limit: AUTOMATION_QUEUE_LIMIT, queue_diagnostics: { rejected_requests: rejectedRequestCount, last_rejected_at: lastQueueRejectedAt, last_wait_ms: lastQueueWaitMs, max_wait_ms: maxQueueWaitMs }, active_id: activeId, tabs: pages.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })), login, profile: profileName, viewport, device_type: clientDeviceType(request), network_policy: { mode: networkPolicy.mode, allowed_hosts: networkPolicy.allowedHosts, resolve_dns: networkPolicy.resolveDns }, started_at: startedAt, source_mtime: sourceMtime, browser_version: browserVersion.product || null, browser_recovering: recovering, browser_restart_count: browserRestartCount, last_browser_restart: lastBrowserRestart, last_browser_error: lastBrowserError });
      }
      if (request.method === 'GET' && url.pathname === '/api/frame') {
        const { data } = await (await page()).send('Page.captureScreenshot', { format: 'jpeg', quality: 82, captureBeyondViewport: false });
        response.setHeader('content-type', 'image/jpeg');
        return response.end(Buffer.from(data, 'base64'));
      }
      if (request.method !== 'POST') return json({ error: '不支持的请求' }, 405);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 128 * 1024) return json({ error: '请求过大' }, 413);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (url.pathname === '/api/read' || url.pathname === '/api/search') return json(await queuedAutomate(body, url.pathname.endsWith('/search')));
      if (busy) return json({ error: 'Agent 正在读取独立标签页，请稍后操作' }, 409);
      if (url.pathname === '/api/scroll') {
        const deltaX = Number(body.deltaX) || 0;
        const deltaY = Number(body.deltaY) || 0;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 3000 || Math.abs(deltaY) > 3000) throw new Error('滚动距离超出支持范围');
        const client = await page();
        // 中文说明：网页可能把滚动放在根元素，也可能放在内容内部；按视口中心选择当前可滚动容器。
        await scrollAt(client, deltaX, deltaY);
        const scroll = await scrollMetrics(client);
        return json({ ok: true, scroll });
      }
      if (url.pathname === '/api/viewport') {
        const width = Number(body.width), height = Number(body.height);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1920 || height < 240 || height > 1600) throw new Error('画面尺寸超出支持范围');
        viewport = { width, height };
        for (const client of pageClients.values()) await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
        return json(viewport);
      }
      if (url.pathname === '/api/tab') { activeId = await newTab(await protectedUrl(body.url)); return json({ id: activeId }); }
      if (url.pathname === '/api/select') {
        if (!(await tabs()).some(tab => tab.id === body.id)) throw new Error('标签页不存在');
        activeId = body.id; return json({ id: activeId });
      }
      if (url.pathname === '/api/close') {
        if ((await tabs()).length < 2) throw new Error('至少保留一个标签页');
        await browserSend('Target.closeTarget', { targetId: activeId });
        pageClients.get(activeId)?.close(); pageClients.delete(activeId); activeId = null;
        return json({ ok: true });
      }
      if (url.pathname === '/api/navigate') { await (await page()).send('Page.navigate', { url: await protectedUrl(body.url) }); return json({ ok: true }); }
      if (url.pathname === '/api/input') {
        const client = await page();
        if (body.type === 'text') await client.send('Input.insertText', { text: String(body.text || '').slice(0, 20000) });
        else if (body.type === 'key') await client.send('Input.dispatchKeyEvent', { type: body.up ? 'keyUp' : 'rawKeyDown', key: String(body.key || ''), code: String(body.code || ''), windowsVirtualKeyCode: Number(body.keyCode) || 0, modifiers: Number(body.modifiers) || 0 });
        else if (body.type === 'mouse') await client.send('Input.dispatchMouseEvent', { type: body.up ? 'mouseReleased' : body.move ? 'mouseMoved' : 'mousePressed', x: Number(body.x) || 0, y: Number(body.y) || 0, button: body.move ? 'none' : body.button === 2 ? 'right' : 'left', buttons: body.up ? 0 : body.button === 2 ? 2 : 1, clickCount: body.move ? 0 : 1 });
        else if (body.type === 'wheel') {
          const deltaX = Number(body.deltaX) || 0;
          const deltaY = Number(body.deltaY) || 0;
          const point = { x: body.x, y: body.y };
          const before = await scrollMetrics(client, point);
          await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(body.x) || 0, y: Number(body.y) || 0, button: 'none', buttons: 0, clickCount: 0, deltaX, deltaY });
          await delay(20);
          let scroll = await scrollMetrics(client, point);
          // 中文说明：部分站点或移动 WebView 不响应 CDP 的 mouseWheel，位置未变化时直接滚动目标容器。
          if ((deltaX || deltaY) && scroll.top === before.top && scroll.left === before.left && (scroll.maxTop > 0 || scroll.maxLeft > 0)) {
            await scrollAt(client, deltaX, deltaY, point);
            scroll = await scrollMetrics(client, point);
          }
          return json({ ok: true, scroll });
        }
        else throw new Error('不支持的输入类型');
        return json({ ok: true });
      }
      return json({ error: '不存在的接口' }, 404);
    } catch (error) {
      if (response.headersSent) return response.end();
      const status = Number.isInteger(error.status) ? error.status : 400;
      if (error.retry_after) response.setHeader('retry-after', String(error.retry_after));
      const details = failureDetails({ ...error, status }, `http_${status}`);
      if (error.diagnostics) details.diagnostics = error.diagnostics;
      json({ error: error.message, ...details }, status);
    }
  });
  async function shutdown() {
    if (closing) return;
    closing = true;
    server.close(); server.closeAllConnections();
    for (const client of pageClients.values()) client.close();
    if (browserCdp?.isOpen()) await browserSend('Browser.close').catch(() => {});
    browserCdp?.close();
    await stopChild(launched?.child);
    const current = await fs.readFile(STATE_FILE, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.pid === process.pid) await fs.unlink(STATE_FILE);
    await releaseProfileLock();
    options.onClose?.();
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8791, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    options.tunnel?.onUrlChange?.(updatePublicOrigin);
    await options.tunnel?.ready?.();
    await writeState();
    console.log(`浏览器工作台：${baseUrl}/#token=${token}`);
    if (publicOrigin) {
      console.log(`手机 HTTPS 工作台：${publicOrigin}/#token=${token}`);
      if (options.tunnel?.mode) console.log(`公网隧道模式：${options.tunnel.mode}`);
    }
    console.log(`登录资料：${profile}\n工作台用于人工登录和验证；登录后 CLI/MCP 可直接读取和搜索。`);
    console.log(`远程访问：ssh -N -L ${server.address().port}:127.0.0.1:${server.address().port} 用户@服务器`);
    const installedBytes = await directoryBytes(RUNTIME_ROOT);
    if (installedBytes > 400_000_000) console.error('提示：浏览器安装目录已超过 400 MB，请用 doctor 检查空间预算。');
    process.once('SIGINT', () => shutdown().catch(console.error));
    process.once('SIGTERM', () => shutdown().catch(console.error));
    watchBrowser(launched.child);
  } catch (error) { await shutdown(); throw error; }
}

// 中文说明：导出站点脚本供离线夹具测试，服务运行路径仍只通过 serve 使用这些脚本。
export { BILIBILI_READ, ZHIHU_READ, XIAOHONGSHU_READ, WEIBO_READ, WEIBO_SEARCH, DOUYIN_SEARCH, DOUYIN_READ, fetchBilibiliSubtitle, hydrateBilibiliSubtitle, detailNavigationUnavailable, detailContentPending, detailContentUnavailable, siteSearchInterruption, siteForHostname };
