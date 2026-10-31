# browser-hub：独立远程浏览器与 Agent 会话

`browser-hub` 把浏览器登录资料留在部署机器上，并提供两条使用路径：人通过轻量工作台完成登录，CLI/MCP 在后台读取页面和执行站内搜索。Agent 不需要持续传输浏览器画面，也不需要读取系统浏览器 Cookie。

## GitHub 独立仓库布局

本仓库对应项目中的 `tools/browser-hub`，建议克隆到项目根目录的 `tools/browser-hub`：

```bash
git clone git@github.com:Red-noblue/browser-hub.git /项目根目录/tools/browser-hub
```

Browser Hub 复用 `tools/agent-search/shared/` 中的正文转换、网络策略、恢复诊断和字幕模块；需要完整功能时，应把 `agent-search` 仓库同时克隆到同一项目的 `tools/agent-search`。两个目录各自是独立 Git 仓库，`data/`、`run/`、`evidence/` 和浏览器运行时只在部署机生成，不进入仓库。

第一次接入建议只记这条路径：`serve` 启动服务 → 工作台完成一次登录 → `status` 确认服务 → CLI/MCP 调用 `search/read`。工作台是登录和验证码入口，不是 Agent 的日常搜索接口。

## 网络安全边界和大小限制

服务默认以 `public` 网络策略运行。CLI/MCP 的 `/api/tab`、`/api/navigate`、站内搜索和正文读取会拒绝凭据 URL、localhost、回环、私网、IPv6 链路本地及云实例 metadata 地址；域名还会检查 DNS 解析结果。浏览器的顶层文档请求和重定向会再次执行同一检查，普通图片、脚本和 WebSocket 子资源仍由 Chromium 按站点页面加载。被拒绝时返回结构化 `target_blocked_private`、`target_credentials_forbidden` 或 DNS 诊断。

单用户且明确需要访问内网夹具时，启动时显式选择：

```bash
tools/browser-hub/bin/browser-hub serve --network-mode local
tools/browser-hub/bin/browser-hub serve --network-mode public --allowed-hosts example.com,example.org
```

`public` 是默认值；`local` 不应和公网 Tunnel 一起用于不受信任的访问者。`status` 会显示当前 `network_policy`。B站字幕响应默认限制 16 MiB，图片默认限制 30 MiB；响应在流式读取时超过上限会返回 `response_too_large`，不会先把完整内容读入内存或留下半截下载文件。

## 安装

项目使用共享 Node 环境，不在本目录创建 `node_modules`：

```bash
cd /Users/zhangyansong/Documents/MyProjects_zys/projects
tools/browser-hub/bin/install-deps.sh
tools/browser-hub/bin/browser-hub install-browser
```

`install-browser` 会把精简 Chromium 放入 `.venvs/browser-hub`。如果目标机器已有 Chromium，也可以跳过安装并使用：

macOS 下也可以显式通过 `bash` 启动服务：

```bash
bash tools/browser-hub/bin/browser-hub serve --browser /path/to/chromium
```

检查实际占用和 Linux 动态库：

```bash
tools/browser-hub/bin/browser-hub doctor
```

`doctor` 会分别显示浏览器二进制、隧道、Profile 总量、Profile 缓存、持久化 Profile 数据、下载文件和共享依赖。运行输出与持久数据已经分开：默认 `run/` 只放可清理的状态、锁、快照和临时输出，`data/` 保存登录 Profile 与用户下载文件，`evidence/` 保存历史报告。Profile 会随登录和缓存增长，不应打包进发布物；可以用 `BROWSER_HUB_DATA_ROOT`、`BROWSER_HUB_RUN_ROOT` 分别指向部署机上的私有目录。

`status` 的 `session.profile_lock` 和 `doctor` 的 `profiles[].lock`、`profile_locks` 会显示 Profile 锁是否为 `active`、`stale`、`absent` 或 `corrupt`，以及持有进程 PID。输出不会包含锁 nonce、Cookie 或登录资料。服务升级前已经启动的旧进程可能暂时显示 `absent`，重启服务后才会创建新锁。

空间以 `doctor` 的实际输出为准：当前 macOS ARM64 精简 Chromium 约 211 MB，官方 Chrome for Testing 的 Linux x64/ARM64 安装包解压后约 283/287 MB；登录 Profile、缓存和下载图片会继续增长。因此 0.5 GB 只能作为初始预算参考，不能当作运行上限。安装前可以用 `install-browser.py --inspect --target linux-x64` 或 `linux-arm64` 只读取官方 ZIP 目录估算体积，不下载浏览器主体。Chromium 的 `--disk-cache-size=16MB` 只是缓存后端的软参数，不是整个 Profile 的硬磁盘配额；实测加载约 100 MB 的可缓存资源后，缓存目录仍可能增长到约 100 MB。需要回收空间时，以 `doctor` 和 `clean-cache --dry-run` 的实际统计为准。

如果 Profile 缓存持续增长，先停止对应的 `serve` 进程，再手动清理可再生缓存：

```bash
# 只清理 mobile Profile 的 Chromium 缓存
tools/browser-hub/bin/browser-hub clean-cache --profile mobile

# 清理所有已停止 Profile 的 Chromium 缓存
tools/browser-hub/bin/browser-hub clean-cache

# 只预览 mobile Profile 可清理的缓存，不停止服务、不修改文件
tools/browser-hub/bin/browser-hub clean-cache --profile mobile --dry-run
```

`clean-cache` 只删除 `Cache`、`Code Cache`、GPU/媒体缓存、Service Worker 缓存等可再生目录，不会删除 Cookie、Local Storage、IndexedDB、登录资料或下载图片。服务正在使用的 Profile 会被拒绝清理。
`--dry-run` 只读取目录并返回每个缓存目录的体积；运行中的 Profile 也可以预览，结果中的 `lock_state` 会显示其是否正在使用。预览结果中的 `cleared_bytes` 表示预计可清理体积，实际清理结果中的该字段表示已经清理的体积。

测试回归产生的隔离 Profile 位于 `run/test-tmp`，与登录 Profile 分开。确认没有正在运行的测试后，可以只清理这些临时目录：

```bash
tools/browser-hub/bin/browser-hub clean-test-tmp --dry-run
tools/browser-hub/bin/browser-hub clean-test-tmp
```

该命令不会触碰 `data/profiles`、`data/downloads`、`run/read-snapshots` 或 `evidence`。`doctor` 和 `status` 会分别显示 `test_tmp` 占用，以及浏览器是否实际带有 `--proxy-server`、代理端点是否可连接和本次隧道模式；代理端点只显示本机地址，不显示任何凭据。微博登录页、二维码和新浪静态资源在部分代理节点上会被代理直接断开，默认只对微博相关域名使用直连绕过；其他站点继续走项目代理。可用 `BROWSER_HUB_PROXY_BYPASS_LIST` 覆盖该列表。

## 启动和登录

仅本机使用：

```bash
tools/browser-hub/bin/browser-hub serve --profile mobile
```

服务会先等待启动页加载并成功生成截图，再发布本机工作台地址；调试端口可连接但页面不能渲染时会退出，不发布成功状态，并释放自建进程和 Profile 锁。打开工作台，点击小红书、知乎或 B 站按钮，在远程浏览器中完成登录。登录资料只保存在该 Profile，后续 `read`、`search` 和 MCP 调用会复用同一会话。

服务器没有显示器时，优先使用 SSH：

```bash
# 在笔记本或手机终端执行
ssh -N -L 8791:127.0.0.1:8791 user@server
# 然后在本地浏览器打开
http://127.0.0.1:8791
```

也可以使用临时 HTTPS 工作台。先安装一次项目内的 `cloudflared`：

```bash
tools/browser-hub/bin/browser-hub install-tunnel
tools/browser-hub/bin/browser-hub serve --profile mobile --tunnel
tools/browser-hub/bin/browser-hub link
```

把 `link` 输出的完整 HTTPS 地址复制到手机。地址包含一次性接管令牌，不要发布到公共聊天或日志中。

## ERR_NAME_NOT_RESOLVED 和隧道恢复

临时域名只在对应的 `cloudflared` 进程存活期间有效。服务重启后，旧域名会失效，这是 Cloudflare quick tunnel 的行为，不能通过 DNS 固定旧地址。

`serve --tunnel` 现在会自动完成以下步骤：

1. 启动直连隧道并等待 HTTPS 入口真正返回 2xx/3xx；域名刚分配但 DNS 尚未完成时会继续等待。
2. 直连失败时自动重试，并调用项目 `tools/proxy-tunnel` 重新建立隧道。
3. 健康检查发现连续两次失效时自动更换域名，并更新 `run/session.json`；重新运行 `browser-hub link` 获取新地址。
4. Node 原生请求不读取 `HTTPS_PROXY`，健康检查会同时使用 `fetch` 和 `curl`，因此不会把代理可达入口误判为 DNS 失败。

需要强制选择路径时：

```bash
# 强制使用项目代理
tools/browser-hub/bin/browser-hub serve --profile mobile --tunnel --proxy

# 只使用直连，不自动启动 proxy-tunnel
tools/browser-hub/bin/browser-hub serve --profile mobile --tunnel --no-proxy
```

`proxy-tunnel` 没有可用节点、Cloudflare 入口持续返回 530，或网络禁止临时隧道时，使用 SSH 端口转发。它不依赖公网 DNS，也不会产生临时域名。

## CLI 调用

```bash
tools/browser-hub/bin/browser-hub status
tools/browser-hub/bin/browser-hub read https://example.com --max-chars 8000
tools/browser-hub/bin/browser-hub search bilibili "机器学习" --limit 10
tools/browser-hub/bin/browser-hub search zhihu "远程浏览器" --limit 10

# 小红书图片默认只返回 URL；显式指定项目内目录后才下载图片文件
tools/browser-hub/bin/browser-hub read "https://www.xiaohongshu.com/search_result/<笔记ID>?xsec_token=<搜索结果中的令牌>" \
  --max-chars 50000 --download-images tools/browser-hub/data/downloads/xhs
```

直接使用 `browser-hub read` 时不需要传 `--source`；`agent-search read` 也会按已适配平台的可信域名自动选择 browser-hub，显式 `--source` 优先，实际路径见返回的 `routing`。

未自动选源的普通网址也可以从Agent Search显式调用：`tools/agent-search/bin/agent-search-project read "完整网址" --reader browser`，MCP传 `reader: "browser"`。使用当前Profile及登录会话，失败不静默降级HTTP；快照续读可省略reader。默认auto与显式http仍保留公开读取路径，不会给所有站点增加浏览器负担。

B 站搜索只返回真正的 `www.bilibili.com/video/BV...` 视频条目，会排除“投稿”“高级弹幕”等后台链接，并严格遵守 `--limit`。读取 B 站视频时优先调用页面会话可访问的 B 站接口，返回标题、作者、发布时间、播放/点赞/评论/收藏和时长；播放器提供临时字幕地址时，由服务端读取字幕 JSON，避免浏览器页面的跨域限制。视频没有可访问字幕时，`content_status` 为 `api_metadata`，`missing_fields` 会包含 `subtitle`，不把视频页面可见的推荐列表误当成正文。

知乎文章/回答和小红书笔记会优先解析页面内的结构化初始数据，返回正文、作者、发布时间和互动字段，`content_status` 为 `site_structured`。直接读取知乎问题 URL（没有 `/answer/...`）时只返回问题描述和元数据，`content_status` 为 `question_metadata`，`missing_fields` 会包含 `answer_content`；需要完整回答时应先搜索或提供具体回答 URL。若知乎只提供 `excerpt`，结果会保留摘要并在 `warnings` 标记，不把摘要当作全文。小红书详情依赖搜索结果携带的 `xsec_token`；没有令牌、令牌过期或笔记已删除时，可能只能返回 `not_found_or_blocked`。小红书搜索和读取同时兼容 `explore`、`search_result`、`discovery/item` 和 `item` 详情路径。小红书读取默认返回图片 URL、尺寸和数量，不把二进制图片放入 Agent 上下文；只有传入 `--download-images <目录>` 才会把图片下载到项目工作区，并在 `image_download.downloaded` 中返回本地文件、类型和字节数。下载目录不能位于项目工作区之外。图片笔记仍不执行 OCR。

`status` 是排查入口，返回服务、浏览器、本地 API、隧道和当前 Profile 的结构化状态。服务项还会显示启动时间、服务加载的源码时间和当前源码时间；`source_newer_than_service: true` 表示源码更新后尚未重启服务。退出码为 0 表示当前服务可用；退出码为 1 表示服务未运行、本地 API 不可达或公网隧道连续探测失败。隧道刚启动时 DNS 可能尚未稳定，工具最多重试 3 次：

```bash
bash tools/browser-hub/bin/browser-hub status
bash tools/browser-hub/bin/browser-hub link
```

`link` 输出的是当前运行的临时接管地址。服务重启或隧道重建后，旧地址会失效，必须重新运行 `link`；不要把带 `#token` 的完整地址写入日志、文档或公共问题报告。

Agent 的 `search` 和 `read` 请求由服务端排队处理。队列最多保留 8 个进行中的请求（包含当前请求）；超过上限会返回 HTTP 429、`retry_after: 3` 和 `Retry-After: 3`，调用方应等待后重试。状态接口会在 `local.queued`（或 API 状态的 `queued`）中显示数量，并提供 `queue_limit`；不要同时启动多个浏览器 Profile。

API 抛错和 CLI 错误保留 `code`、`status`、`retry_after`，附 `recovery`（`retryable`、`retry_after_seconds`、`next_action`、`instruction`）。CLI 错误输出 stderr JSON，退出码仍为1；旧的 `error` 文字字段保留。队列满为 `browser_adapter_busy`，服务停止为 `browser_service_stopped`，快照过期/已淘汰分别为 `snapshot_expired/snapshot_not_found`。指引不自动启动服务、登录或重新抓取快照；API拒绝和站点403也不等于账号未登录。

浏览器进程在没有 Agent 读取或搜索请求时意外退出，服务会自动重建 Chromium、重新连接 CDP，并继续使用同一个 Profile、服务令牌和本地端口。恢复期间 `status` 的 `local.browser_recovering` 为 `true`，工作台标签页会回到启动页；正在进行的读取请求不会被伪装成成功结果，若崩溃发生在读取期间，服务会停止并保留 Profile，避免返回半截正文。`local.browser_restart_count` 和 `local.last_browser_error` 可用于排查反复崩溃。

详情读取会在知乎、小红书或 B 站的结构化数据出现后提前结束，避免重复请求；如果页面跳回首页、登录页或风控页，结果会标记为 `not_found_or_blocked`，不会把导航内容当成正文。B站使用播放器 WBI 接口查询字幕，并校验返回的视频和分P标识；接口拒绝或身份不匹配记为读取失败，不当作“没有字幕”。`subtitle_failure_count` 和失败原因保留失败的尝试，`diagnostics.subtitle_server_fallback=true` 表示浏览器请求失败后由服务端成功补取，`subtitle_page_count` 反映实际取得字幕的分P数。

多P字幕按P分组补取：只补浏览器未取得的P，每P选择一个成功语言轨道，默认优先中文、其次英文；不会把同一P的不同语言拼成重复正文。`subtitle_pages[]` 返回所选语言、候选语言、状态和补取标记，不包含临时字幕地址。`--pages 13-17` 或 `--pages 1,3` 选择最多12P；未指定时读取URL的 `?p=13`，没有该参数时沿用前12P。`--subtitle-language en-US` 精确指定轨道，不存在时为 `language_unavailable`，不改用其他语言。`subtitle_selection` 给出选定P、请求语言、全视频P数、未请求数量和保存上限。`available` 只表示本次范围，`partial` 表示范围内仍有缺失或达到上限；选定5P成功不是整套17P已读。

```bash
bash tools/browser-hub/bin/browser-hub read "https://www.bilibili.com/video/BV18BbkzbEr9" \
  --pages 13-17 --subtitle-language en-US --compact --max-chars 8000
```

按需读取字幕时间：`read "BV视频URL" --pages 13 --subtitle-language en-US --compact --start-seconds 60 --end-seconds 120`。API使用 `timestamps/start_seconds/end_seconds`；只加 `--timestamps` 则保留全文范围。原始 `from/to` 为各P内秒数，范围 `[start,end)` 返回重叠整句，不能作为整套视频累计时间。`subtitle_cues` 仅包含当前窗口相交句子的 `page/from/to/url/range`，文字不重复；`range` 为快照全文UTF-16位置，跨窗口引用可重现。跳转URL用 `p` 和向下取整的 `t`，原始小数秒保留；`partial=true` 标记被提取上限截断的句子。

浏览器与服务端CORS补取采用相同筛选规则。没有有效时间的句子，无范围时保留文字、null时间与链接；筛选时排除，保留 `subtitle_timing` 缺失计数和不完整提示。`subtitle_status=no_match` 表示取得轨道但没有范围内匹配，不是无字幕或网络失败；此时可返回 `api_metadata`。快照续读与lean保留相交时间引用，find返回匹配片段引用，export将全部引用放在metadata.json；旧纯文本快照不能补时间，变更范围需新读。默认不增加时间信息，不与清单合用；CLI、MCP真实20项核对与独立字幕证据见 `tools/agent-search/evidence/quality-timestamps-20261025/`。该轮只验证链接参数；后续可用 `tools/agent-search/bin/agent-search-project verify-live --playback` 在本机当前会话核对独立字幕并静音验证实际起播。四组样本5170句、四次分P播放已通过，观测偏差<0.3秒，见 `tools/agent-search/evidence/quality-live-20261025/final.json`；不代表其他机器的媒体解码能力。联网回归不加入默认测试，完整说明见[Agent Search联网回归](../agent-search/README.md#b站字幕联网回归)。

只查分P与语言：`read "B站BV视频URL" --list-tracks --pages 13-17`（API `list_tracks=true`）。复用当前登录会话，在站内轻量页面访问元数据接口，不加载视频播放器或下载字幕/媒体。默认前12P，URL的p参数或pages可选择后续范围，每次最多12P。`response_mode=catalog`、`content_status=metadata_only`、`content=null`，不创建正文快照。`video_catalog` 返回总P数、选中/未检查范围、标题/时长/语言和请求计数；`track_status=listed/not_available/unavailable` 分别表示接口列出轨道、成功返回空列表、查询失败。`catalog_status=complete/partial` 仅描述所选范围的查询完整性，不代表字幕正文已可读。清单与快照、find、导出、图片下载、语言选择、格式、时间定位、compact和lean分开调用。

真实13–17P样本：清单1900字节，CDP观察到1次轻量页面、6次元数据API请求，字幕/媒体均为0；后续选择en-US读取成功。CLI、MCP和17项检查通过，证据见 `tools/agent-search/evidence/quality-catalog-20261025/`；轨道或会话变化仍可能影响之后的正文读取。

`--compact` 新读取最多保存每P200000字符、合计1000000字符，字幕仅出现在 `content` 窗口，不返回重复 `subtitle` 字段。后续用同一URL、快照和 `next_offset` 续读，省略compact和选择参数时沿用快照；改变分P或语言会报 `snapshot_mismatch`。不加compact的旧调用保留每P20000、总计60000字符和原有字幕字段。达到保存上限或所选P字幕缺失时仍标记 `source_truncated`，续读不能补回。对旧快照开启compact仅减少重复输出，不会重新抓取；`--no-compact` 可对本次恢复兼容字段。

2026-10-25 实测17P双语课程的第13–17P英文字幕共322381字符，41个窗口拼接及导出与独立可访问字幕文件一致；第13P中文字幕和缺失语言也已核对。同一快照、同一8000字符窗口的兼容/紧凑JSON分别347799/12220字节，减少96.49%。这是选定轨道的样本对比，不代表整套课程、视频画面或所有账号网络的完整覆盖。

现在可用 `read "相同URL" --snapshot "编号" --offset "next_offset" --lean`（API `lean=true`）减少续读重复字段。将同一份已核对字幕存入新快照，通过实际CLI比较41个窗口：原紧凑格式493950字节，首次完整、后续精简386214字节，减少21.81%，正文拼接与导出哈希一致。此为保存字幕的回放，不重新联网提取；统计JSON的UTF-8字节，不含MCP封装，也不是token节省率。记录与复测脚本在 `tools/agent-search/evidence/quality-lean-20261025/`。全量分页仍高于该新快照一次兼容输出347842字节，因此全量保存优先导出。

精简续读返回 `response_mode=lean`，保留正文、分页、完整性状态、缺失字段、全部警告和错误及非空风险诊断。`snapshot.id` 和 `metadata_ref.snapshot_id` 引用首次完整响应，标题、作者、来源、分P/语言列表及固定诊断不再逐窗重复。需要完整元数据与哈希时，同一URL/快照省略 `--lean`，设置 `--offset 0`；`metadata_ref.offset` 只用于重读元数据，分页仍用 `content_window.next_offset`。lean每次显式提供，不持久改变格式或抓取上限；只适用于已有快照，不与find、导出、图片下载或 `--no-compact` 合用。服务未更新时CLI明确要求重启，避免静默忽略参数。
`read` 结果还会返回 `diagnostics`：`site` 表示识别到的平台，`attempts` 是页面检查次数，`redirected` 表示最终地址是否变化，`extraction` 表示提取方式，`unavailable_reason` 会区分详情链接跳转和站点登录/风控页面。它们用于排查适配问题，不代表站点一定允许读取全部内容。

`diagnostics.site` 会按最终域名标记 `youtube`、`reddit`、`gitee`、知乎、小红书、B 站、微博和抖音；无法识别的域名才是 `generic`。这只是来源归类，不表示已为该站点增加正文解析或绕过访问限制。
正文结果还会返回 `content_window`（偏移、请求/返回字符数、是否还有后续窗口和 `next_offset`）；仅当 `next_offset` 有值时使用 `read --offset <next_offset>` 续读。偏移使用 UTF-16 代码单元，直接沿用返回值；`requested_offset` 保留请求偏移，`offset` 是实际起点，超出末尾时返回空窗口。若 `source_truncated=true` 且 `next_offset=null`，上游没有提供剩余文本，续读不能补全。稳定分页时同时传 `--snapshot <上次返回的 snapshot.id>`，后续窗口读取同一份正文，不再访问页面；省略快照则仍重新访问。快照在项目内独立保存，有效一小时，每次保存时按 100 份、32 MiB 目标淘汰旧记录；多个服务并发写入时不是严格磁盘配额。后续读写会清理到期文件，不启动后台清理进程。失效时明确报错，不静默抓取新版。`provenance` 返回正文哈希、提取方式、读取时间和当前 UTF-16 片段范围。

浏览器 API 的状态接口会额外返回活动请求耗时、当前排队数、最大等待时间和队列拒绝累计数，便于区分站点慢与队列拥塞。

建议把浏览器工作台和 Agent 网关分开理解：工作台只用于首次登录、验证码和人工验证；登录完成后，CLI/MCP 通过本地受保护接口读取页面并执行搜索，不需要持续传输画面。

当前内置站内搜索适配：小红书、知乎、B 站、YouTube、Reddit、微博、抖音和 Gitee。站点可能要求登录、验证码或动态加载；返回结果明确标记为当前页面可见摘要，不宣称覆盖站内全部内容。未适配站点可以先用 `read` 读取完整网址。

抖音详情读取目前只在页面 `meta description` 同时提供作品文案、作者、日期和点赞字段时标记为 `site_structured`；这类结果仍只是作品元数据和文案，不包含视频画面、音频或字幕。只有残缺的“于某日发布在抖音……”描述时会返回 `metadata_incomplete` 诊断并保留 `browser_text`，不会把残缺 meta 宣称为完整正文；缺少 meta 时返回 `metadata_missing`。抖音视频详情不能据此推断视频内容已被转写。

2026-10-27五站固定调查：Gitee直连首轮一条查询返回3个原生候选，公开仓库取得4000字符可见文字窗口，404负例独立确认；同一 Chromium Profile 显式使用项目HTTP代理后，YouTube取得3个原生候选，固定公开视频读取为1604字符可见文本，无效视频被识别为不可用；YouTube直连首轮连接重置。Reddit代理复测仍无正例候选，固定负例返回403访问受限；当轮调查中的微博、抖音未取得查询候选或登录后详情正例，微博负例出现newlogin跳转，抖音负例出现加载占位或无效视频提示；这些是当时节点和会话的结论。首轮直连失败副本、代理复测和独立复查均保存在 `tools/agent-search/evidence/next-round-20261027/`；不合并宣称五站当轮全通过。

随后在同一已登录 `mobile` Profile 中复测微博：查询“人工智能”返回2条原生候选，`native_count=2`、`fallback_count=0`；候选保留作者、时间和互动字段。服务按最新源码重启后再次读取固定移动详情，返回 `content_status=site_structured`、HTTP 200、正文、作者、时间、转发/评论/点赞统计和1条图片索引，`source_truncated=false`，说明登录会话可跨服务重启复用。这只证明当前会话和当前节点的样本可用；历史失败记录不删除。证据见 `tools/agent-search/evidence/next-round-20261027/weibo-search-after-restart.json`、`weibo-after-restart.json` 和 `weibo-after-stats-fix.json`。

2026-10-28在同一 `mobile` Profile 继续复测：YouTube 站内查询和固定公开视频读取成功；Reddit 搜索页面稳定返回 HTTP 403，CLI 错误同时保留 `diagnostics.site=reddit`、`diagnostics.http_status=403` 和 `reason=access_restricted`，应按站点访问限制排查，不能解释为未登录或内容不存在。Gitee 的显式浏览器读取仍可能 `ERR_CONNECTION_CLOSED`，但 `agent-search read` 的默认 `auto` 路径会回退公开 HTTP 并返回 `routing.reader=public_http`；因此“浏览器失败”和“正文无法读取”必须分别判断。当前节点下的实测失败记录保存在项目 `run` 目录，未用更换样本掩盖失败。

同轮以直接Node启动的隔离Chromium集成已验证渲染、图片、队列、手机输入、空闲崩溃恢复，以及Cookie和快照跨重启保留；6组离线单元也通过。Agent Search的独立登录夹具另验证显式reader在CLI/MCP及批量中的一致性、主框架HTTP403、连接断流和停止服务后的明确诊断。测试没有访问业务账号，报告位于 `tools/agent-search/evidence/next-round-20261027/`；业务站点限制仍以对应调查结果为准。

读取会记录主框架HTTP状态 `diagnostics.http_status`，不会将403/404错误页当作有效正文；iframe子页面错误不作为主页面状态。`Page.navigate`明确失败时返回 `browser_navigation_failed` 及网络检查指引，不再将连接重置解释成空正文。仍不能据此定位DNS、TLS或具体代理节点故障。

## Markdown 与按需图片

```bash
tools/browser-hub/bin/browser-hub read "文章 URL" --format markdown
tools/browser-hub/bin/browser-hub read "相同 URL" --snapshot "返回的编号" --offset 8000
tools/browser-hub/bin/browser-hub read "相同 URL" --snapshot "返回的编号" --find "原文关键词"
tools/browser-hub/bin/browser-hub read "相同 URL" --snapshot "返回的编号" --export tools/browser-hub/run/research
tools/browser-hub/bin/browser-hub read "小红书结果原始 URL" --snapshot "返回的编号" --download-images tools/browser-hub/data/downloads/selected --image-indexes 1,3
```

默认文本输出兼容旧接口。Markdown 保留通用页面、知乎文章/回答中的标题、代码、链接、列表和常见表格；复杂排版仍可能损失。图片编号来自 `images[].index`，指定编号后只下载这些图片；不指定时最多下载 20 张。已有文件不会覆盖，失败放入 `image_download.errors`，重下应使用新目录。本工具不执行 OCR 或视觉识别。

`images[].width/height` 及 `image_download.downloaded[].width/height` 均保留站点清单尺寸。下载后复用现有Chromium，在临时后台标签页解码文件，返回 `decoded`、`actual_width/actual_height` 和 `manifest_dimensions_match`；不新增依赖，完成后关闭解码页。清单缺少尺寸或解码失败时，匹配值为 `null`；解码失败还返回 `decode_error=image_decode_failed`（文件无法解码）或 `image_decode_unavailable`（浏览器解码调用不可用），实际宽高为 `null`，仍保留已保存文件并发出警告。尺寸不同也会发出警告，不能把站点清单当作下载文件尺寸。

2026-10-25检查两篇固定笔记的9张图片：站点只提供预览与默认地址，18份文件均实测解码；预览压缩更小但尺寸相同。两张图片在两种地址下均从清单宽1179缩为实际宽1080，点击网页图片后也未观察到更大尺寸地址。因此目前仍使用站点默认链接，尚无经过验证的原尺寸下载档位；尺寸相同也不能证明是原始上传文件或无损文件。脱敏调查记录位于 `tools/agent-search/evidence/quality-images-20261025/provided-variants.json`。Agent Search的[图文联网回归](../agent-search/README.md#图文联网回归)会独立核对文件字节、实际解码尺寸及生产下载返回的尺寸字段。

后续扩样新增5张1856×4080长图及5张约5334×7114大图，两种站点地址仍分别缩为1080×2374和1080×1440，未发现可验证的更大尺寸地址。格式测试另保存[W3C公开格式测试页](https://www.w3.org/People/mimasa/test/imgformat/)的PNG/JPEG小文件到 `tests/fixtures/`，共2681字节；来源文件均为72×48，与生成的透明长PNG、大尺寸JPEG及WebP一起检查完整字节、文件类型、实际尺寸和权限。W3C真实文件、合成边界夹具与小红书WebP分别记录，不能把标题中的“PNG”当成实际文件格式。测试后续可离线运行。

`image_download.errors[]` 另返回 `code`、可用的HTTP `status`、`retry_after` 及 `recovery`；原 `error` 文字字段保留。429遵循等待指引，断流按网络恢复指引处理，使用图片编号只重试失败项。图片在响应完整接收后才保存，连接中断不留下不完整文件，后续图片继续处理；已有同名文件仍不会覆盖。站点初始数据中的文案为空时，提示当前文案为空并保留 `body_text` 缺失标记，不代表已经识别图中文字。

`--find` 是区分大小写的原文字面查找，返回 `matches` 片段及 UTF-16 位置，继续查找用 `find.next_offset`。`--export` 保存指定快照的全部已提取正文和来源元数据，只返回 `exported` 路径与哈希。这两种操作均需 `--snapshot`，不重新访问页面，返回 `content=null`，也不重复返回完整字幕；不会补回上游缺失文本、图片文字或评论。

## 运行目录和部署

- 源码：`tools/browser-hub`
- 浏览器和隧道二进制：`.venvs/browser-hub`
- 共享 WebSocket 和 Markdown 转换依赖：`.venvs/0node_module`
- 共用正文逻辑：`tools/agent-search/shared/reading.mjs`
- 共用恢复指引：`tools/agent-search/shared/recovery.mjs`
- 共用分P/语言校验：`tools/agent-search/shared/bilibili.mjs`
- 可清理运行输出：`tools/browser-hub/run`（`session.json`、Profile 锁、短期快照、测试临时目录和临时文件）
- 登录 Profile：`tools/browser-hub/data/profiles`（Cookie、Local Storage、IndexedDB 等登录资料，不能随意删除）
- 用户下载文件：`tools/browser-hub/data/downloads`（需要保留的图片等文件，不能按缓存清理）
- 历史验收与诊断证据：`tools/browser-hub/evidence`（不参与运行，可单独归档）

部署时复制工具源码、完整共用代码 `tools/agent-search/shared/`（包括 `reading.mjs`、`outline.mjs`、`recovery.mjs`、`bilibili.mjs`）、共享依赖和需要的浏览器二进制，并保留上述相对目录布局；只部署 Browser Hub 时也需复制该共用代码子目录，无需复制 Agent Search 的其他源码、配置或私有数据。发布包通常排除 `data/` 和 `evidence/`；若要迁移登录会话，必须整体保留目标 Profile 并确认浏览器版本兼容。服务只监听 `127.0.0.1`，远程访问必须使用 SSH 或显式 HTTPS 隧道。停止服务使用启动它的终端按 `Ctrl+C`，工具只会停止自己创建的浏览器和 cloudflared 进程。`bin/browser-hub` 已由包装器直接执行项目共享 Node；带 `--proxy` 时在当前进程注入 `proxy-tunnel` 环境，避免旧的包装器递归链。

目录变量可以独立指定：`BROWSER_HUB_RUN_ROOT`（运行输出）、`BROWSER_HUB_DATA_ROOT`（默认包含 `profiles/` 与 `downloads/`）、`BROWSER_HUB_PROFILE_ROOT` 和 `BROWSER_HUB_DOWNLOAD_ROOT`（分别覆盖数据子目录）。显式设置 `BROWSER_HUB_RUN_ROOT` 做测试时，如果没有同时设置 `BROWSER_HUB_DATA_ROOT`，Profile 会自动放到 `<run>/data`，避免测试污染正式登录资料。运行期间不要移动正在使用的 Profile；迁移旧版本时，先停止服务，再执行：

```bash
mkdir -p tools/browser-hub/data
mv tools/browser-hub/run/profiles tools/browser-hub/data/profiles
mv tools/browser-hub/run/downloads tools/browser-hub/data/downloads
```

如果目标目录已经存在，应按 Profile 名逐个合并并人工核对，不能覆盖同名登录资料。只清理空间时删除 `run/` 下的状态、快照和临时输出即可；不要删除 `data/profiles`、`data/downloads` 或 `evidence`，`clean-cache` 是清理 Chromium 缓存的安全入口。

Markdown快照还可显式读取目录：`read "相同URL" --snapshot "编号" --outline`（API `outline=true`）。返回章节标题及UTF-16范围，正文为null；选择章节时用 `read "相同URL" --snapshot "编号" --section <range.start> --lean`（API `section_start`），省略offset即从标题开始，自动在章节末尾停止，不再次导航。长节续读保留section参数，并传 `content_window.next_offset`；`section.range` 是章节范围，`content_window.scope=section`，`has_more/next_offset` 只描述节内剩余正文，缺失标记和警告仍保留。目录每页最多100项，`max_chars` 约束标题字符和，用 `outline.next_offset` 翻目录。纯文本快照报告 `markdown_required`；与查找、lean、导出、下载分开调用。普通读取不增加目录；具体规则与限制见[Agent Search目录说明](../agent-search/README.md#长文目录与章节定位)。

## 验证

```bash
# 项目根目录；测试临时文件全部留在工作区内
mkdir -p tools/browser-hub/run/test-tmp
TMPDIR="$PWD/tools/browser-hub/run/test-tmp" PATH="$PWD/.venvs/0node/bin:$PATH" \
  .venvs/0node/bin/npm --cache "$PWD/.venvs/0node_module/.npm-cache" run test:unit --prefix tools/browser-hub
.venvs/0node/bin/node tools/browser-hub/tests/integration.mjs
.venvs/0node/bin/node --check tools/browser-hub/src/tunnel.mjs
.venvs/0node/bin/node --check tools/browser-hub/src/server.mjs
# 不启动真实浏览器，检查网络边界和子进程回收
.venvs/0node/bin/node tools/browser-hub/tests/security.mjs
```

单元测试包括缓存、CDP、doctor、隧道、站点夹具、网络边界、统一子进程回收、包装器直接/代理入口，以及“调试端口可用但页面渲染失败”的启动故障注入。真实 Chromium 测试检查初始启动期间没有意外重启，再验证正文、快照内查找与导出、图片、手机工作台和故意终止浏览器后的恢复。崩溃测试先通过正常重启确认夹具 Cookie 已持久化；强制终止 Chromium 不能保证尚未落盘的最新 Cookie 不丢失。

2026-10-26，共用正文转换加入论文表格精简后的回归中，6组单元测试通过；当时 `npm test` 的真实浏览器阶段曾出现下述 ICU 启动错误，同一环境改用直接 Node 命令则集成测试通过。此处保留历史故障证据，当前包装器启动链已有独立回归检查。测试使用独立临时 Profile，未读取或改动用户账号资料。

`npm test` 会依次运行全部测试。2026-10-24 在本机 macOS ARM64、项目位于 Documents 的环境中，由 Node 18.20.8 启动 npm 10.8.2 可复现 Chromium 子进程 ICU 加载失败，系统日志同时记录资源目录读取被拒绝；改由项目内临时安装并校验 SHA-256 的官方 Node 24.20.0 启动同一份 npm，集成测试连续三次通过，测试服务仍使用原项目 Node 18。仅切换 Bash、工作目录、npm 环境变量或独立进程会话没有稳定解决。这个历史对比尚未证明系统内部根因，也不代表所有 macOS 或 Node 18 环境都有问题；直接 Node 命令仍可用于隔离 npm 启动链。诊断用 Node 24 已在测试结束后清理，没有替换共享运行时。若再次遇到该历史故障，可显式执行：

```bash
# 使用已经安装的 Node 24 绝对路径，不会替换项目共享 Node
BROWSER_HUB_TEST_NODE_BIN="/absolute/path/to/node24"
TMPDIR="$PWD/tools/browser-hub/run/test-tmp" \
  npm_config_cache="$PWD/.venvs/0node_module/.npm-cache" \
  PATH="$PWD/.venvs/0node/bin:$PATH" \
  "$BROWSER_HUB_TEST_NODE_BIN" .venvs/0node_module/lib/node_modules/npm/bin/npm-cli.js \
  run test:integration --prefix tools/browser-hub
```

若再次出现 `icudtl.dat not found in bundle`，不能仅据此判定文件缺失或直接删除 Profile；先运行包装器回归检查，再结合安装文件、启动 Node 版本和 macOS 文件访问拒绝日志判断。工具不会为此自动关闭沙箱或修改系统隐私设置。
