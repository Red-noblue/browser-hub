// 中文说明：使用离线页面状态夹具验证知乎、小红书和 B 站读取边界，不访问真实账号和站点。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BILIBILI_READ, ZHIHU_READ, XIAOHONGSHU_READ, WEIBO_READ, WEIBO_SEARCH, DOUYIN_SEARCH, DOUYIN_READ, fetchBilibiliSubtitle, hydrateBilibiliSubtitle, detailNavigationUnavailable, detailContentPending, detailContentUnavailable, siteSearchInterruption, siteForHostname } from '../src/server.mjs';

assert.equal(detailNavigationUnavailable('https://weibo.com/0/0000000000000000', 'https://weibo.com/newlogin?url=fixture'), true, '实测登录首页不能冒充微博详情');
assert.equal(detailNavigationUnavailable('https://weibo.com/123/AbCd', 'https://weibo.com/123/AbCd'), false);
assert.equal(detailNavigationUnavailable('https://www.douyin.com/video/7517162696970734882', 'https://www.douyin.com/video/7517162696970734882'), false);
assert.equal(detailNavigationUnavailable('https://www.douyin.com/video/7517162696970734882', 'https://www.douyin.com/jingxuan?modal_id=7668562855364398351'), true, '抖音跳到其他推荐视频不能冒充原详情');
assert.equal(detailNavigationUnavailable('https://weibo.com/', 'https://weibo.com/newlogin'), false, '非详情请求不强制要求详情路径');
assert.equal(detailContentPending('https://www.douyin.com/video/0000000000000000000', '导航 页脚 视频数据加载中'), true);
assert.equal(detailContentPending('https://www.douyin.com/video/123', '作品说明 正文'), false);
assert.equal(detailContentPending('https://example.com/video/123', '教程解释：视频数据加载中'), false, '不能误伤其他网站的正常文字');
assert.equal(detailContentUnavailable('https://www.douyin.com/video/0000000000000000000', '你浏览的视频不是有效视频\n去精选页查看更多视频'), true);
assert.equal(detailContentUnavailable('https://www.douyin.com/video/0000000000000000000', '登录后免费畅享高清视频\n扫码登录\n验证码登录'), true);
assert.equal(detailContentUnavailable('https://www.douyin.com/video/123', '正常作品文案'), false);
assert.equal(detailContentUnavailable('https://example.com/video/123', '教程引用：登录后免费畅享高清视频'), false);
assert.equal(detailContentUnavailable('https://www.youtube.com/watch?v=00000000000', '登录\n此视频无法再播放\n转到“首页”'), true);
assert.equal(detailContentUnavailable('https://www.youtube.com/watch?v=abc', '正常视频标题和简介'), false);
assert.equal(detailContentUnavailable('https://example.com/watch?v=abc', '此视频无法再播放'), false, '不能误伤其他网站的正常文字');
assert.equal(detailContentUnavailable('https://m.weibo.cn/detail/0', '该微博不存在\n返回首页'), true);
assert.equal(detailContentUnavailable('https://m.weibo.cn/detail/123', '微博正文内容'), false);
assert.equal(siteSearchInterruption('douyin', { title: '验证码中间页', frameSources: ['https://verify.invalid/frame'] }), 'site_verification_required');
assert.equal(siteSearchInterruption('douyin', { challengeFrameVisible: true }), 'site_verification_required');
assert.equal(siteSearchInterruption('douyin', { text: '请完成验证，拖动滑块' }), 'site_verification_required');
assert.equal(siteSearchInterruption('douyin', { scriptSources: ['https://lf-cdn-tos.invalid/captcha/index.js'], challengeFrameVisible: false }), null, '普通页面加载验证码脚本不表示当前受验证拦截');
assert.equal(siteSearchInterruption('douyin', { frameSources: ['https://verify.invalid/frame'], challengeFrameVisible: false }), null, '隐藏的验证 iframe 不表示当前受验证拦截');
assert.equal(siteSearchInterruption('douyin', { title: '发现更多精彩视频 - 抖音' }), null);
assert.equal(siteSearchInterruption('weibo', { title: '验证码中间页' }), null, '抖音验证诊断不能误判其他来源');
for (const [host, expected] of [['www.youtube.com', 'youtube'], ['youtu.be', 'youtube'], ['www.reddit.com', 'reddit'], ['redd.it', 'reddit'], ['gitee.com', 'gitee'], ['m.weibo.cn', 'weibo'], ['example.com', 'generic']]) assert.equal(siteForHostname(host), expected);

function textNode() {
  return {
    _html: '',
    set innerHTML(value) { this._html = String(value || ''); },
    get innerText() { return this._html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim(); },
    get textContent() { return this.innerText; }
  };
}

function run(expression, context, options = {}) {
  return vm.runInNewContext(`(${expression})(${JSON.stringify(options)})`, { URL, URLSearchParams, ...context }, { timeout: 1000 });
}

function runValue(expression, context) {
  return vm.runInNewContext(expression, { URL, URLSearchParams, ...context }, { timeout: 1000 });
}

// 中文说明：抖音结果是没有锚点的瀑布流卡片，视频 ID 从外层 waterfall_item 节点生成详情地址。
const douyinCard = ({ id, title, author, date, duration, likes }) => {
  const values = new Map([
    ['.BjLsdJMi', title], ['.WldPmwm5', author], ['.dO8W7uoF', '· ' + date],
    ['.FnM1bbIQ', duration], ['.pMq55q1M', likes]
  ]);
  return {
    innerText: [duration, likes, title, author, date].join('\n'),
    closest: selector => selector === '[id^="waterfall_item_"]' ? { id: 'waterfall_item_' + id } : null,
    querySelector: selector => values.has(selector) ? { innerText: values.get(selector) } : null
  };
};
const douyinResults = runValue(DOUYIN_SEARCH.replace('__LIMIT__', '2'), {
  document: { querySelectorAll: selector => selector === '.search-result-card' ? [
    douyinCard({ id: '7609502381008604466', title: '机器学习是什么：通过数据学习规律', author: '谦行AIing', date: '2月22日', duration: '18:53', likes: '4038' }),
    douyinCard({ id: '7609502381008604466', title: '重复卡片', author: '重复', date: '', duration: '', likes: '' }),
    douyinCard({ id: '7614886431651106099', title: '线性回归入门', author: '算法作者', date: '3月8日', duration: '20:36', likes: '1.5万' })
  ] : [] }
});
assert.equal(douyinResults.length, 2, '应去重并遵守 limit');
assert.equal(douyinResults[0].url, 'https://www.douyin.com/video/7609502381008604466');
assert.equal(douyinResults[0].title, '机器学习是什么：通过数据学习规律');
assert.equal(douyinResults[0].author, '谦行AIing');
assert.equal(douyinResults[0].published_at, '2月22日');
assert.deepEqual(JSON.parse(JSON.stringify(douyinResults[0].stats)), { likes: '4038', duration: '18:53' });
assert.equal(douyinResults[1].url, 'https://www.douyin.com/video/7614886431651106099');

const douyinDetail = runValue(DOUYIN_READ, {
  document: {
    querySelector(selector) {
      const values = {
        'meta[name="description"]': '机器学习入门：从线性回归开始\n - 算法作者于20250618发布在抖音，已经收获了1.5万个喜欢，来抖音，记录美好生活！',
        'meta[name="lark:url:video_title"]': '机器学习入门：从线性回归开始'
      };
      return values[selector] ? { content: values[selector] } : null;
    }
  }
});
assert.equal(douyinDetail.ready, true);
assert.equal(douyinDetail.douyin_metadata, true);
assert.equal(douyinDetail.author, '算法作者');
assert.equal(douyinDetail.published_at, '2025-06-18');
assert.deepEqual(JSON.parse(JSON.stringify(douyinDetail.stats)), { likes: '1.5万' });
assert.match(douyinDetail.text, /机器学习入门/);
const douyinIncomplete = runValue(DOUYIN_READ, {
  document: { querySelector: selector => selector === 'meta[name="description"]' ? { content: '于20261028发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！' } : null }
});
assert.equal(douyinIncomplete.ready, false);
assert.equal(douyinIncomplete.diagnostic_code, 'metadata_incomplete');

const initialData = JSON.stringify({ initialState: { entities: {
  questions: { '123': { title: '问题标题', detail: '<p>问题描述</p>', answerCount: 7, author: { name: '提问者' } } },
  articles: { '456': { title: '文章标题', excerpt: '<p>文章摘要</p>', author: { name: '作者' } } },
  answers: { '789': { content: '<p>回答正文</p>', createdTime: 1767613680, updatedTime: 1767613707 } }
} } });
const document = {
  getElementById(id) { return id === 'js-initialData' ? { textContent: initialData } : null; },
  createElement() { return textNode(); }
};

const question = run(ZHIHU_READ, { location: { pathname: '/question/123' }, document });
assert.equal(question.ready, true);
assert.equal(question.question_without_answer, true);
assert.equal(question.answer_count, 7);
assert.equal(question.diagnostic_code, 'question_without_answer');
assert.match(question.text, /问题描述/);

const article = run(ZHIHU_READ, { location: { pathname: '/p/456' }, document });
assert.equal(article.ready, true);
assert.equal(article.body_text_missing, true);
assert.equal(article.body_is_excerpt, true);
assert.equal(article.diagnostic_code, 'body_excerpt_only');
const answer = run(ZHIHU_READ, { location: { pathname: '/question/123/answer/789' }, document });
assert.equal(answer.published_at, '2026-01-05T11:48:00.000Z', '知乎回答使用 createdTime，应保留发布时间');
const errorPage = run(ZHIHU_READ, { location: { pathname: '/question/123/answer/789' }, document: { ...document, querySelector: selector => selector === '.ErrorPage' ? { innerText: '请求错误\n无法访问当前页面' } : null } });
assert.equal(errorPage.ready, true);
assert.equal(errorPage.site_unavailable, true, '知乎ErrorPage不能冒充普通正文');
assert.equal(errorPage.diagnostic_code, 'site_error_page');
assert.equal(errorPage.text, undefined);

const xhs = run(XIAOHONGSHU_READ, {
  location: { pathname: '/discovery/item/abc123' },
  document: { title: '小红书笔记' },
  window: { __INITIAL_STATE__: { note: { noteDetailMap: { abc123: { note: { title: '笔记', desc: '正文', time: 1700000000, imageList: [] } } } } } }
});
assert.equal(xhs.ready, true);
assert.equal(xhs.published_at, '2023-11-14T22:13:20.000Z');

const weiboRoot = {
  querySelector(selector) {
    if (selector === '.weibo-text') return { innerText: '微博正文内容' };
    if (selector === '.weibo-top h3') return { innerText: '微博作者' };
    if (selector === '.weibo-top .time') return { innerText: '10-23 20:20' };
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes('tab-item')) return [
      { querySelectorAll: () => [{ innerText: '转发' }, { innerText: '30' }], innerText: '转发30' },
      { querySelectorAll: () => [{ innerText: '评论' }, { innerText: '33' }], innerText: '评论33' },
      { querySelectorAll: () => [{ innerText: '赞' }, { innerText: '189' }], innerText: '赞189' },
      { querySelectorAll: () => [{ innerText: '收藏' }, { innerText: '7' }], innerText: '收藏7' }
    ];
    return [];
  }
};
const weibo = run(WEIBO_READ, {
  location: { hostname: 'm.weibo.cn', pathname: '/detail/5357277725858479' },
  document: { title: '微博', querySelector: selector => selector === '.card.f-weibo' ? weiboRoot : null, querySelectorAll: selector => selector.includes('tab-item') ? weiboRoot.querySelectorAll(selector) : [] }
});
assert.equal(weibo.ready, true);
assert.equal(weibo.weibo_mobile, true);
assert.equal(weibo.author, '微博作者');
assert.equal(weibo.published_at, '10-23 20:20');
assert.equal(JSON.stringify(weibo.stats), JSON.stringify({ shares: '30', comments: '33', likes: '189', favorites: '7' }));
assert.match(weibo.text, /微博正文内容/);

// 中文说明：模拟微博真实搜索卡片，确认原生候选、移动详情地址和互动字段不会退化成通用搜索摘要。
const action = text => ({ innerText: text });
const detailLink = { href: 'https://weibo.com/123/AbCd', innerText: '10-23 20:20' };
const validCard = {
  matches: selector => selector === '.card-wrap',
  closest: () => validCard,
  getAttribute: name => name === 'mid' ? '5357277725858479' : null,
  querySelector(selector) {
    if (selector.includes('feed_list_content')) return { innerText: '微博搜索正文' };
    if (selector === '.name') return { innerText: '微博作者' };
    if (selector === '[nick-name]') return null;
    if (selector === '[action-type="feed_list_forward"]') return action('转发 30');
    if (selector === '[action-type="feed_list_comment"]') return action('评论 33');
    if (selector === '[action-type="feed_list_like"]') return action('赞 189');
    return null;
  },
  querySelectorAll: selector => selector === 'a[href]' ? [detailLink] : []
};
const navigationCard = {
  matches: selector => selector === '.card-wrap',
  closest: () => navigationCard,
  getAttribute: () => null,
  querySelector: () => null,
  querySelectorAll: () => []
};
const search = runValue(WEIBO_SEARCH.replace('__LIMIT__', '5'), {
  location: { href: 'https://s.weibo.com/weibo?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD' },
  document: { querySelectorAll: () => [validCard, navigationCard] }
});
assert.equal(search.length, 1);
assert.equal(search[0].url, 'https://m.weibo.cn/detail/5357277725858479');
assert.equal(search[0].source_url, 'https://weibo.com/123/AbCd');
assert.equal(JSON.stringify(search[0].stats), JSON.stringify({ shares: '30', comments: '33', likes: '189' }));

const missingWeibo = run(WEIBO_READ, {
  location: { hostname: 'm.weibo.cn', pathname: '/detail/5357277725858479' },
  document: { title: '微博', querySelector: () => ({ querySelector: () => null, querySelectorAll: () => [] }) }
});
assert.equal(missingWeibo.ready, false);
assert.equal(missingWeibo.body_text_missing, true);
assert.equal(missingWeibo.diagnostic_code, 'body_missing');

const bili = await run(BILIBILI_READ, {
  location: { pathname: '/video/BVfixture' },
  document: { title: '视频' },
  fetch: async () => new Response('暂时不可用', { status: 503 })
});
assert.equal(bili.ready, false);
assert.equal(bili.diagnostic_code, 'api_request_failed');
assert.equal(bili.api_status, 503);

const longSubtitle = await run(BILIBILI_READ, {
  location: { pathname: '/video/BVfixture' }, document: { title: '长字幕' },
  fetch: async url => {
    if (url.includes('/view?')) return Response.json({ code: 0, data: { aid: 1, title: '长字幕', pages: [{ cid: 123 }] } });
    if (url.includes('/player/')) {
      assert.match(url, /\/x\/player\/wbi\/v2\?aid=1&cid=123$/);
      return Response.json({ code: 0, data: { aid: 1, cid: 123, subtitle: { subtitles: [{ subtitle_url: 'https://caption.invalid/p1' }] } } });
    }
    return Response.json({ body: [{ content: '字'.repeat(21000) }] });
  }
});
assert.equal(longSubtitle.source_content_truncated, true, '单 P 字幕达到截取上限时必须标明缺失');
assert.equal(longSubtitle.subtitle_page_count, 1);
assert.equal(longSubtitle.subtitle_source_pages['https://caption.invalid/p1'], 1);
for (const [player, reason] of [[{ code: -403 }, 'player_api_rejected'], [{ code: 0, data: { aid: 2, cid: 123 } }, 'player_video_mismatch']]) {
  const rejected = await run(BILIBILI_READ, {
    location: { pathname: '/video/BVfixture' }, document: { title: '接口错误' },
    fetch: async url => Response.json(url.includes('/view?') ? { code: 0, data: { aid: 1, pages: [{ cid: 123 }] } } : player)
  });
  assert.equal(rejected.subtitle_status, 'unavailable', '接口拒绝或身份不匹配不能视为视频没有字幕');
  assert.equal(rejected.subtitle_failures[0].reason, reason);
}
const previousFetch = globalThis.fetch;
try {
  globalThis.fetch = async url => Response.json({ body: [{ content: url.endsWith('p1') ? '第一 P 字幕' : '第二 P 字幕' }] });
  const sources = ['https://caption.invalid/p1', 'https://caption.invalid/p2'];
  const recovered = await fetchBilibiliSubtitle(sources, { [sources[0]]: 1, [sources[1]]: 2 });
  assert.equal(recovered.page_count, 2, '服务端补取字幕后页数必须反映实际成功的 P');
  assert.equal(recovered.text, 'P1：\n第一 P 字幕\n\nP2：\n第二 P 字幕');
  assert.equal(recovered.source_content_truncated, false);

  // 浏览器取得P1、P2因CORS失败；服务端应只补P2，并且每P只选一个语言。
  const requested = [];
  const fixtureFetch = async url => {
    requested.push(String(url));
    if (url.includes('/view?')) return Response.json({ code: 0, data: { aid: 1, pages: [{ cid: 1, part: '开头' }, { cid: 2, part: '后续' }] } });
    if (url.includes('/player/')) {
      const cid = Number(new URL(url).searchParams.get('cid'));
      return Response.json({ code: 0, data: { aid: 1, cid, subtitle: { subtitles: [
        { lan: 'en', lan_doc: '英语', subtitle_url: `https://caption.invalid/${cid}-en` },
        { lan: 'zh-Hans', lan_doc: '简体中文', subtitle_url: `https://caption.invalid/${cid}-zh` }
      ] } } });
    }
    if (String(url).includes('/2-')) throw new Error('CORS');
    return Response.json({ body: [{ content: '第一 P 中文' }] });
  };
  const multi = await run(BILIBILI_READ, { location: { pathname: '/video/BVfixture' }, document: { title: '多P' }, fetch: fixtureFetch });
  assert.equal(multi.subtitle_page_count, 1);
  assert.equal(multi.subtitle_pages[0].language, 'zh-Hans', '中文轨道即使排在英语后面也应优先');
  const serverRequests = [];
  globalThis.fetch = async url => {
    serverRequests.push(String(url));
    return Response.json({ body: [{ content: String(url).endsWith('-zh') ? '第二 P 中文' : 'English duplicate' }] });
  };
  const hydrated = await hydrateBilibiliSubtitle(multi);
  assert.equal(hydrated.subtitle_page_count, 2);
  assert.equal(hydrated.subtitle_status, 'available');
  assert.deepEqual(serverRequests, ['https://caption.invalid/2-zh'], '不重取成功P、不合并多语言');
  assert.match(hydrated.subtitle, /P1 开头：\n第一 P 中文\n\nP2 后续：\n第二 P 中文/);
  assert.equal(hydrated.subtitle_pages[1].server_fallback, true);
  assert.equal(hydrated.subtitle_pages[1].language, 'zh-Hans');
  assert.ok(!('subtitle_sources' in hydrated) && !('subtitle_entries' in hydrated));

  globalThis.fetch = async () => new Response('', { status: 403 });
  const partial = await hydrateBilibiliSubtitle(multi);
  assert.equal(partial.subtitle_status, 'partial');
  assert.equal(partial.source_content_truncated, true);
  assert.equal(partial.subtitle_pages[1].status, 'unavailable');

  // 一共12P、每P两种语言，不能因为全局前8个地址的旧限制漏掉后续P。
  globalThis.fetch = async url => Response.json({ body: [{ content: '同一段字幕' }] });
  const many = await fetchBilibiliSubtitle(Array.from({ length: 12 }, (_, i) => [
    { page: i + 1, language: 'zh-Hans', url: `https://caption.invalid/${i}-zh` },
    { page: i + 1, language: 'en', url: `https://caption.invalid/${i}-en` }
  ]).flat());
  assert.equal(many.page_count, 12);
  assert.equal(many.entries.length, 12, '不同P的相同字幕也应保留');
  assert.ok(many.entries.every(entry => entry.language === 'zh-Hans'));

  globalThis.fetch = async url => String(url).endsWith('-zh') ? new Response('', { status: 403 }) : Response.json({ body: [{ content: 'English fallback' }] });
  const english = await hydrateBilibiliSubtitle(multi);
  assert.equal(english.subtitle_pages[1].language, 'en', '中文不可用时必须报告实际选中的英语轨道');
  assert.match(english.subtitle, /English fallback/);
} finally { globalThis.fetch = previousFetch; }

// 指定13P以后的分P和英语轨道；紧凑读取保存超过旧20000字符限制的全文。
const selectionRequests = [];
const selectedContext = {
  location: { pathname: '/video/BVfixture', search: '' }, document: { title: '17P双语样本' },
  fetch: async url => {
    selectionRequests.push(String(url));
    if (url.includes('/view?')) return Response.json({ code: 0, data: { aid: 9, pages: Array.from({ length: 17 }, (_, i) => ({ cid: i + 1, part: '第' + (i + 1) + '课' })) } });
    if (url.includes('/player/')) {
      const cid = Number(new URL(url).searchParams.get('cid'));
      return Response.json({ code: 0, data: { aid: 9, cid, subtitle: { subtitles: [
        { lan: 'ai-zh', subtitle_url: `https://caption.invalid/${cid}-zh` },
        { lan: 'en-US', subtitle_url: `https://caption.invalid/${cid}-en` }
      ] } } });
    }
    return Response.json({ body: [{ content: String(url).endsWith('-en') ? 'English😀'.repeat(4000) : '中文字幕'.repeat(8000) }] });
  }
};
const selected = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, selectedContext, { pages: [13, 15], subtitle_language: 'en-us', compact: true }));
assert.equal(selected.subtitle_status, 'available', '选定范围完整时，不因未请求其他P而误报partial');
assert.equal(selected.source_content_truncated, false);
assert.deepEqual([...selected.subtitle_selection.pages], [13, 15]);
assert.equal(selected.subtitle_selection.unrequested_page_count, 15);
assert.ok(selected.subtitle_pages.every(p => p.language === 'en-US'));
assert.equal(selected.subtitle, 'P13 第13课：\n' + 'English😀'.repeat(4000) + '\n\nP15 第15课：\n' + 'English😀'.repeat(4000));
assert.ok(selectionRequests.filter(url => url.includes('/player/')).every(url => /cid=(?:13|15)$/.test(url)), '不能查询未选择分P');
assert.ok(!selectionRequests.some(url => url.endsWith('-zh')), '精确英语请求不能获取其他语言');

const urlPage = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, { ...selectedContext, location: { pathname: '/video/BVfixture', search: '?p=13' } }, { compact: true }));
assert.deepEqual([...urlPage.subtitle_selection.pages], [13]);
assert.equal(urlPage.subtitle_selection.mode, 'url');
const missingLanguage = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, selectedContext, { pages: [13], subtitle_language: 'ja' }));
assert.equal(missingLanguage.subtitle, null);
assert.equal(missingLanguage.subtitle_status, 'unavailable');
assert.equal(missingLanguage.subtitle_pages[0].status, 'language_unavailable');
assert.equal(missingLanguage.subtitle_pages[0].available_languages.length, 2);
const outOfRange = await run(BILIBILI_READ, selectedContext, { pages: [18] });
assert.equal(outOfRange.request_error.code, 'bilibili_pages_out_of_range');

// 中文说明：清单查询只能访问详情与播放器元数据，不请求字幕正文，也不把带临时参数的资源地址返回给Agent。
const catalogRequests = [];
const catalogContext = { ...selectedContext, fetch: async url => {
  catalogRequests.push(String(url));
  assert.ok(url.includes('/view?') || url.includes('/player/'), '清单查询不能下载字幕文件');
  return selectedContext.fetch(url);
} };
const catalog = await run(BILIBILI_READ, catalogContext, { list_tracks: true, pages: [13, 15] });
assert.equal(catalog.response_mode, 'catalog');
assert.equal(catalog.content_status, 'metadata_only');
assert.equal(catalog.catalog_status, 'complete');
assert.equal(catalog.content, null);
assert.equal(catalog.subtitle, undefined);
assert.equal(catalog.video_catalog.total_pages, 17);
assert.deepEqual([...catalog.video_catalog.selected_pages], [13, 15]);
assert.equal(catalog.video_catalog.uninspected_page_count, 15);
assert.equal(catalog.video_catalog.requests.metadata, 3);
assert.equal(catalog.video_catalog.requests.subtitle, 0);
assert.equal(catalogRequests.length, 3);
assert.equal(catalog.video_catalog.pages[0].track_status, 'listed');
assert.equal(catalog.video_catalog.pages[0].title, selected.subtitle_pages[0].title);
assert.ok(catalog.video_catalog.pages[0].languages.some(track => track.language === selected.subtitle_pages[0].language));
assert.doesNotMatch(JSON.stringify(catalog), /caption\.invalid|subtitle_url|English😀/);
const defaultCatalog = await run(BILIBILI_READ, catalogContext, { list_tracks: true });
assert.equal(defaultCatalog.video_catalog.pages.length, 12);
assert.equal(defaultCatalog.video_catalog.requests.metadata, 13);
assert.equal(defaultCatalog.video_catalog.uninspected_page_count, 5);
const robotCatalog = await run(BILIBILI_READ, { ...catalogContext, location: { pathname: '/robots.txt' } }, { list_tracks: true, bvid: 'BVfixture', url_page: '13' });
assert.deepEqual([...robotCatalog.video_catalog.selected_pages], [13]);
assert.equal(robotCatalog.video_catalog.selection_mode, 'url');
assert.equal(robotCatalog.video_catalog.requests.metadata, 2);
const emptyCatalog = await run(BILIBILI_READ, { ...catalogContext, fetch: async url => url.includes('/view?')
  ? Response.json({ code: 0, data: { aid: 1, pages: [{ cid: 1 }] } })
  : Response.json({ code: 0, data: { aid: 1, cid: 1, subtitle: { subtitles: [] } } }) }, { list_tracks: true });
assert.equal(emptyCatalog.catalog_status, 'complete', '接口成功返回无轨道属于成功的元数据查询');
assert.equal(emptyCatalog.video_catalog.pages[0].track_status, 'not_available');
const failedCatalog = await run(BILIBILI_READ, { ...catalogContext, fetch: async url => url.includes('/view?')
  ? Response.json({ code: 0, data: { aid: 1, pages: [{ cid: 1 }] } })
  : Response.json({ code: -403 }) }, { list_tracks: true });
assert.equal(failedCatalog.catalog_status, 'partial');
assert.equal(failedCatalog.video_catalog.pages[0].track_status, 'unavailable');
assert.equal(failedCatalog.video_catalog.pages[0].error.reason, 'player_api_rejected');
assert.equal(failedCatalog.video_catalog.requests.subtitle, 0);
const missingList = await run(BILIBILI_READ, { ...catalogContext, fetch: async url => url.includes('/view?')
  ? Response.json({ code: 0, data: { aid: 1, pages: [{ cid: 1 }] } })
  : Response.json({ code: 0, data: { aid: 1, cid: 1 } }) }, { list_tracks: true });
assert.equal(missingList.catalog_status, 'partial', '接口未提供字幕字段时不能宣称没有轨道');
assert.equal(missingList.video_catalog.pages[0].error.reason, 'subtitle_list_missing');
const missingPages = await run(BILIBILI_READ, { ...catalogContext, fetch: async () => Response.json({ code: 0, data: { aid: 1 } }) }, { list_tracks: true });
assert.equal(missingPages.ready, false);
assert.equal(missingPages.diagnostic_code, 'video_pages_missing');
const manyLanguages = await run(BILIBILI_READ, { ...catalogContext, fetch: async url => url.includes('/view?')
  ? Response.json({ code: 0, data: { aid: 1, pages: [{ cid: 1 }] } })
  : Response.json({ code: 0, data: { aid: 1, cid: 1, subtitle: { subtitles: Array.from({ length: 10 }, (_, i) => ({ lan: 'lang-' + i, subtitle_url: 'https://caption.invalid/' + i })) } } }) }, { list_tracks: true });
assert.equal(manyLanguages.video_catalog.pages[0].languages.length, 10, '清单不能沿用正文的8轨道尝试上限而遗漏语言');

globalThis.fetch = async () => Response.json({ body: [{ content: '补取全文'.repeat(8000) }] });
try {
  const recovered = await hydrateBilibiliSubtitle({ ...selected, metadata_text: '元数据', subtitle_entries: [], subtitle_sources: [{ page: 13, title: '课13', language: 'en-US', url: 'https://caption.invalid/fallback' }], subtitle_selection: { ...selected.subtitle_selection, pages: [13] }, subtitle_pages: [{ page: 13, status: 'unavailable' }], subtitle_status: 'unavailable' });
  assert.equal(recovered.subtitle.length, 'P13 课13：\n'.length + 32000, '服务端补取必须沿用紧凑模式的保存上限');
  assert.equal(recovered.source_content_truncated, false);
} finally { globalThis.fetch = previousFetch; }

// 中文说明：时间定位需同时覆盖浏览器与CORS补取；每P使用自身时间，不能拼成课程累计时间。
const timedLines = [
  { from: 0, to: 1, content: '开头' },
  { from: 1, to: 3.75, content: '跨边界😀\n整句' },
  { from: 3.75, to: 4, content: '后续' },
  { from: 4, to: 4, content: '时间点' },
  { content: '无时间正文' },
  { from: 6, to: 5, content: '倒序时间正文' }
];
const timedContext = { location: { pathname: '/video/BVfixture' }, document: { title: '时间样本' }, fetch: async url => {
  if (url.includes('/view?')) return Response.json({ code: 0, data: { aid: 7, title: '时间样本', pages: [{ cid: 1, part: '甲' }, { cid: 2, part: '乙' }] } });
  if (url.includes('/player/')) return Response.json({ code: 0, data: { aid: 7, cid: Number(new URL(url).searchParams.get('cid')), subtitle: { subtitles: [{ lan: 'en-US', subtitle_url: 'https://caption.invalid/timed' }] } } });
  return Response.json({ body: timedLines });
} };
const timedRaw = await run(BILIBILI_READ, timedContext, { timestamps: true });
const timed = await hydrateBilibiliSubtitle(timedRaw);
const timedLegacy = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, timedContext));
assert.equal(timed.text, timedLegacy.text, '启用时间定位不能丢失纯文本内容');
assert.equal(timedLegacy.subtitle_cues, undefined, '默认读取不增加时间引用开销');
assert.equal(timed.subtitle_cues.length, 12);
assert.equal(timed.subtitle_timing.missing_time_count, 4);
assert.equal(timed.subtitle_timing.excluded_untimed_count, 0);
assert.equal(timed.source_content_truncated, false);
assert.equal(timed.subtitle_cues[1].from, 1);
assert.equal(timed.subtitle_cues[1].to, 3.75);
assert.equal(timed.text.slice(timed.subtitle_cues[1].range.start, timed.subtitle_cues[1].range.end), '跨边界😀\n整句');
assert.equal(timed.subtitle_cues[7].url, 'https://www.bilibili.com/video/BVfixture?p=2&t=1');
assert.equal(timed.subtitle_cues[4].url, null);

const boundedOptions = { timestamps: true, start_seconds: 2, end_seconds: 3.75 };
const boundedRaw = await run(BILIBILI_READ, timedContext, boundedOptions);
const bounded = await hydrateBilibiliSubtitle(boundedRaw);
assert.equal(bounded.subtitle_cues.length, 2, '区间边界返回重叠整句，不混入正好从结束秒开始的字幕');
assert.equal(bounded.subtitle_timing.excluded_untimed_count, 4);
assert.equal(bounded.subtitle_status, 'partial', '未定位的文字被排除时必须报告不完整');
assert.equal(bounded.source_content_truncated, true);
assert.ok(bounded.subtitle_cues.every(cue => cue.from === 1 && cue.to === 3.75));
assert.doesNotMatch(bounded.text, /无时间正文|后续|倒序时间正文/);

const cleanTimedContext = { ...timedContext, fetch: async url => url.includes('caption.invalid') ? Response.json({ body: timedLines.slice(0, 4) }) : timedContext.fetch(url) };
const noTrackTimedContext = { ...timedContext, fetch: async url => String(url).includes('/player/')
  ? Response.json({ code: 0, data: { aid: 7, cid: Number(new URL(url).searchParams.get('cid')), subtitle: { subtitles: [] } } }) : timedContext.fetch(url) };
const noTrackTimed = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, noTrackTimedContext, { timestamps: true }));
assert.equal(noTrackTimed.subtitle_status, 'not_available', '明确无轨道不能因开启时间定位误报读取失败');
assert.equal(noTrackTimed.source_content_truncated, false, '没有字幕轨道不等于已提取字幕被截断');
assert.equal(noTrackTimed.subtitle_cues.length, 0);
const noMatch = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, cleanTimedContext, { timestamps: true, start_seconds: 10, end_seconds: 20 }));
assert.equal(noMatch.subtitle_status, 'no_match');
assert.equal(noMatch.source_content_truncated, false);
assert.equal(noMatch.subtitle_cues.length, 0);
assert.ok(noMatch.subtitle_pages.every(page => page.status === 'no_match'));
const failedPageContext = { ...cleanTimedContext, fetch: async url => String(url).includes('/player/') && String(url).endsWith('cid=2') ? Response.json({ code: -403 }) : cleanTimedContext.fetch(url) };
const incompleteNoMatch = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, failedPageContext, { timestamps: true, start_seconds: 10, end_seconds: 20 }));
assert.equal(incompleteNoMatch.subtitle_status, 'unavailable', '一P无匹配、另一P失败，不能报告整个范围已成功查明无匹配');
assert.equal(incompleteNoMatch.source_content_truncated, true);
const point = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, cleanTimedContext, { timestamps: true, start_seconds: 4, end_seconds: 5 }));
assert.equal(point.subtitle_cues.length, 2);
assert.ok(point.subtitle_cues.every(cue => cue.from === 4 && cue.to === 4));

globalThis.fetch = async () => Response.json({ body: timedLines });
try {
  const corsContext = { ...timedContext, fetch: async url => { if (url.includes('caption.invalid')) throw new Error('CORS'); return timedContext.fetch(url); } };
  const cors = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, corsContext, boundedOptions));
  assert.equal(cors.subtitle, bounded.subtitle, '服务端与浏览器必须采用相同区间筛选');
  assert.deepEqual(JSON.parse(JSON.stringify(cors.subtitle_cues)), JSON.parse(JSON.stringify(bounded.subtitle_cues)));
  const corsFull = await hydrateBilibiliSubtitle(await run(BILIBILI_READ, corsContext, { timestamps: true }));
  assert.equal(corsFull.text, timed.text, '未指定范围时，服务端补取仍须保留无时间原文');
  assert.equal(corsFull.subtitle_timing.excluded_untimed_count, 0);
  const shortened = await hydrateBilibiliSubtitle({ ...timedRaw, subtitle_selection: { ...timedRaw.subtitle_selection, limits: { per_page_chars: 20000, total_chars: 12 } } });
  assert.equal(shortened.source_content_truncated, true);
  assert.ok(shortened.subtitle_cues.every(cue => cue.range.end <= shortened.text.length));
  assert.equal(shortened.subtitle_cues.at(-1).partial, true);
} finally { globalThis.fetch = previousFetch; }

console.log('browser-hub site reader fixture test passed');
