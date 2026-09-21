# 技术笔记

使用教程见 [README.md](README.md)。这里是实现细节、实测结论和踩过的坑。

---

## 数据流

```
[采集]  浏览器里 hook 抖音页面自身的接口响应   →  5,398 个 ID（has_more=0 确认完整）
   ↓    零签名、零 Cookie、零额外请求
[导入]  粘贴 ID 列表，瞬时完成（标题/可播性按需解析 + 本地缓存）
   ↓
[播放]  aweme/detail 取直链 → 本地服务代理 CDN → 原生 <video>
        随机洗牌 + 不重复队列 + 图文贴轮播
```

## 为什么需要一个本地服务

只有两个原因，都不是性能问题：

1. **CORS** —— `aweme/detail` 是 `www.douyin.com` 的接口，从 `127.0.0.1:5178` 直接 fetch 会被浏览器拦。
2. **Referer** —— 视频 CDN（`douyinvod.com`）有防盗链：不带 Referer → 403，带
   `Referer: https://open.douyin.com/` → 206 video/mp4。**浏览器不允许伪造 Referer**，
   所以这一跳只能由服务端代劳。

账号风险为零：全程不发任何 cookie。

## 关键技术结论（全部实测）

| 问题 | 结论 |
|---|---|
| `www.douyin.com` 能否被 iframe 嵌套 | **不能**，真实浏览器渲染「拒绝连接」 |
| 用脚本裸探 `www.douyin.com` 得到的响应头 | **不可信**：WAF 对非浏览器请求返回不含 XFO 的反爬壳页面。**只有真实浏览器能作为判据** |
| 官方嵌入式播放器 | 存在可用：`open.douyin.com/player/video?vid={id}`，无鉴权、允许嵌套、无 XFO/CSP |
| 官方播放器的问题 | **写死 `autoplay=0`** —— 翻遍它的 JS bundle 没有任何 `v("autoplay")` 调用，所以做不了自动连播 |
| 官方播放器的画面 | 无水印、无导流按钮，实测 3 条真实点赞视频画面干净 |
| `aweme/detail` 接口 | `GET /aweme/v1/web/aweme/detail/?aweme_id={id}&aid=6383`，**不需要签名**，但对请求头敏感 |
| 有效请求头 | `user-agent`(Chrome) + `referer: https://open.douyin.com/` + `origin: https://open.douyin.com` + `sec-fetch-*` 三件套。实测 6/6 成功，精简版的组合 0/6 |
| 图片 CDN（`douyinpic.com`） | **没有**防盗链，各种 Referer 都是 206 |
| 非公开视频 | `aweme_detail` 为 null，靠 `filter_detail.detail_msg` + `filter_reason` 判断（如 `status_self_see`）|
| 跨站 Cookie | `SameSite=Lax` 的 cookie 在跨站 iframe 里不发，`SameSite=None` 的会发。对本方案已不重要 —— 现在是公开接口 + 公开播放器，不依赖登录态 |
| 直链有效期 | 约 3 小时。所以不预存直链，只在播放时解析，缓存里只留标题/时长/宽高 |

播放器样例 ID（可直接试）：`7578091056131901007`

### 图文贴的坑

图片帖的响应里**也带一个方形 `video` 字段**。所以必须**先判 `images` 再判 `video`**，
否则会被当成一个正方形视频播出来。

### 图文贴的背景音乐（实测，2026-09）

图文贴用的曲子分两类，**接口对它们的待遇完全不同**，这是这块最容易踩空的地方：

| | 原声（`music.title` = 「@某某创作的原声」） | 有版权的商业曲（如 "Vagrant Poet"） |
|---|---|---|
| `music.play_url.url_list` | 有地址，`ies-music/*.mp3`，~200KB | **空数组** —— 对象在，一个地址都不给（授权限制） |
| 能不能直接用 | 能。实测 200 / `audio/mpeg` / 头部 `49443304`（"ID3"） | **不能**，只走这条路的话这类图文全静音 |
| 兜底 | —— | 用作品自带的音频轨（见下） |
| `is_use_music` | `false`（"原声"不算用曲库） | `true` |

**商业曲的兜底办法**：图文贴响应里那个方形 `video` 字段其实是**纯音频轨** ——
实测它前 512KB 里只有 `soun` / `mp4a`，**没有 `vide` / `avc1`**，也就是
「画面定格 + 混好音」的那条流。`video.play_addr` 照样能播（实测 206 / `audio/mp4`），
代价是文件大得多（实测 8.2MB / 523 秒，而原声只有 234KB / 14 秒）。
`musicOf()` 返回的 `musicFrom` 会标出用的是哪条（`music` / `video-audio`）。

其他几条实测结论：

| 问题 | 结论 |
|---|---|
| 要不要 Referer/Cookie | **都不要**。无 Referer 也 200 |
| `is_use_music` 能当判据吗 | 能（它表示"是否用了曲库"），但**别拿它代替地址判断**：原声是 `false` 却照样有地址。判据始终是"地址存不存在" |
| 时长够不够铺满一组图 | **常常不够**：原声实测只有 11~14 秒，而一组图能停十几秒。所以是**循环**放的 |
| 中转白名单 | `douyinstatic.com` 必须加进 `ALLOWED_CDN`，否则被那个 403 挡掉，表现为"图文没声音" |
| 其他可用字段 | `music.title`、`music.duration`（完整曲长，商业曲也有）、`music.can_background_play: true` |
| `music.strong_beat_url` | 存在但**不能当音源**：实测返回 `text/plain` + JSON 错误体 |

只有图文贴返回音乐字段（`musicOf()` 只在 `images` 分支里展开）；视频自带音轨，不需要。

## 采集器原理

三层互补，全部跑在你自己已登录的浏览器里：

1. **网络层（主力）**：钩住 `fetch` / `XMLHttpRequest`，从页面自己请求的 `/aweme/` 响应里
   **递归**捞 `aweme_id`（`urlOf()` 处理 string / Request / URL 三种入参）
2. **DOM 层**：扫页面所有 `<a href>` 里的 `/video/{id}` 与 `modal_id={id}`，每 4 轮一次
3. **兜底层**：正则扫整页 HTML，抓 SPA 内联数据里的视频链接

翻页靠自动滚动触发。**不涉及签名、不碰 cookie、不额外请求接口** —— 只是把页面本来就在加载的数据记下来。

### 踩过的两个坑

- **卡在 237 个**：原因是滚动逻辑猜错了滚动容器，且用 `block:"end"` 会把「加载哨兵」
  推出视口。改成对最后一张卡片 `scrollIntoView({block:"center"})` + `jiggle()` 回滚重试后解决。
- **DOM 兜底从不执行**：原判定条件是 `round % 10 === 0`，而 `idleRounds` 是 8，
  永远等不到那一轮。改成每 4 轮一次 + 开跑时立即扫一次。

### 大批量模式

| 改造 | 原因 |
|---|---|
| 以网络捕获为主，DOM 扫描降为每 4 轮 | 上万条时 DOM 查询会变得极慢 |
| 自动存盘到 localStorage，打开页面自动续采 | 跑几十分钟，标签页崩了不能前功尽弃 |
| 自适应调速：有数据加速到 1000ms，没数据减速到 3500ms | 兼顾速度与「确认到底」|
| 后台标签警告 | 浏览器会把后台标签定时器限流到每分钟一次 |

实测：5,398 个，约 1,040 个/分，总耗时约 6 分钟，`has_more=0` 确认到底。

## 三个必须先说清楚的风险

1. **⚠️ 采集期间标签页必须保持前台可见。** 放在一边但保持可见即可；一旦切到别的标签，
   浏览器会限流到每分钟一次。这是最容易导致失败的一点。
2. **浏览器内存**：抖音列表页会持续堆积 DOM 节点，上万条时标签页可能变慢甚至崩溃。
   崩溃不丢数据（有存盘），但重启后要**从头再滚一遍**。建议中途定期「下载 TXT」留底。
3. **服务端回溯上限未知**：`/aweme/v1/web/aweme/favorite/` 是标准游标分页（`max_cursor`），
   理论上能翻很深，但抖音是否对历史深度设限查不到确切数字。本次实测是 5,398 条到底，
   **不保证别人的账号或以后也是这个数**。

## 采集数据存在哪

`localStorage["tlk_collector_v2"]`，属于 `https://www.douyin.com` 这个 origin。存的是 JSON：

```js
{ v: 2, ids: "id1\nid2\n…", count: 5398, rounds: 314, savedAt: 1758…, reason: "stop" }
```

`reason` 取值：`auto`（每 5 轮自动存）、`stop`（点停止）、`finish`（跑到判定到底）、
`import`（从文件恢复）。**「停止并存盘」不是唯一的写入口**，正常情况下还没点它数据就已经在盘上了。

物理位置是浏览器的 LevelDB：`<用户配置>\Local Storage\leveldb\*.ldb`。

⚠️ **LevelDB 里那份不能当备份**：数据块是压缩的，只能读出开头一小部分 ID，元信息也会被二进制
噪声打乱，而且库会被浏览器自己压实重写。**只有下载的 TXT 是可靠的。**

localStorage 按「浏览器 + 用户配置 + 站点」三重隔离 —— 不在账号里、不同步，换浏览器、
无痕窗口、清过站点数据、清理软件扫过都会让它变空。这就是「从 TXT / JSON 恢复」按钮存在的原因。

## 已知限制

- **非公开视频拿不到播放地址**：私密、已删除、仅好友可见的内容只能跳过，无绕过余地。
- **直链有时效**（约 3 小时），所以每次播放都要重新解析一次。
- **短链展开**：重定向跟随已验证，但「有效短链 → 提取 ID」未实测（手里没有活短链）。
- **画面尺寸依赖浏览器**：1080p 源在 16:10 显示器上全屏渲染成 1920×1080，刚好像素级；
  换非 16:9 屏会有缩放。

## 如果网页版翻不到几万条

那就只能走带签名的直连接口（`a_bogus` + `x-secsdk-web-signature`），即最开始排除的那条路。
不必自己逆向，已有成熟实现：

- [mafqla/douyin-api](https://github.com/mafqla/douyin-api)（Python，含签名实现与接口文档）
- [CornerLittleDust/DouyinDownloader](https://github.com/CornerLittleDust/DouyinDownloader)（完整工具，支持「喜欢」采集）

代价是要维护签名，请求频率高时**有账号风控风险**。

## 调试

采集器的 `CONFIG` 在脚本顶部：

```js
startDelay: 1200,   // 初始每轮等待（ms）
minDelay: 1000,     // 最快；别更快，滚过头会错过「加载哨兵」
maxDelay: 3500,     // 最慢（没数据时，用来确认是不是真到底了）
idleRounds: 8,      // 连续多少轮无新增 → 先尝试「回滚重试」，而不是直接判定到底
maxJiggles: 6,      // 最多重试几次，之后才认定到底
domScanEvery: 4,    // 每几轮做一次 DOM 兜底扫描（必须 < idleRounds）
cooldownMs: 90000,  // 回滚也无效时先冷却这么久再重试（对付限流）
maxCooldowns: 3,    // 最多冷却重试几次
```

跑测试（两套，都是零依赖）：

```powershell
cd collector
node smoke-test.mjs                                  # 采集器 22 项，含从备份恢复的路径
node smoke-test.mjs "路径\douyin-likes-xxx.txt"       # 额外校验一份真实导出文件
```

## 前端实现备忘

- **应用外壳布局**：`html,body{height:100%}` + `body{display:flex;flex-direction:column;overflow:hidden}`，
  整页永不滚动，左栏在它自己内部滚。这样 `stage.clientHeight` 是稳定的，
  播放区尺寸可以直接量，不会出现「内容撑高 stage → stage 又决定内容」的循环。
- **播放区尺寸按朝向分开处理**：横屏让盒子贴合视频比例（同时撑满宽高、不裁切），
  竖屏铺满宽度 + 占满可用高度，两侧留白给模糊背景。
- **模糊背景**用一张 64×36 的 canvas，CSS 放大 + 重模糊，**视频和图文共用**：
  视频取第一帧（`loadeddata` 时），图文取**当前正在显示的那张图**（每张显示时重新取样，
  所以背景跟着当前图的配色走）。取样源不同但都经本地服务同源中转，`drawImage` 不会污染 canvas。
  - 图文能取到色的前提是 `.poster` 用了 `object-fit:contain`：竖图在横屏 stage 里两侧会留白，
    那圈留白才透得出 ambient（元素盒子本身是满的，不留白就没地方显示）。
  - 取样点放在 `poster.decode()` 完成之后（poster 已赋值且已解码，`naturalWidth` 才有值）。
    实测两条不同颜色的图，canvas 取到的平均色与源图一致（`#e61414` / `#1428e6`）。
- **方向键必须挂在捕获阶段**：原生 `<video controls>` 在它的 shadow DOM 里自己处理方向键/空格，
  冒泡阶段挂监听器时事件冒上来已经被处理完了。捕获阶段 + `stopPropagation` 才能拦住。
- **切换视频时不要碰 `controls` 属性**：改 `src` 会触发一次 `pause`，Chrome 一见暂停就显示控制条，
  于是进度条一闪、文案被顶上去。现在只在第一次 `mousemove` / `pointerdown` 时才恢复 `controls`。
- **`<video>` 的 `background` 必须是 `transparent`**：`object-fit:contain` 时元素盒子仍是满的，
  设成 `#000` 会把底下的模糊背景整个盖住。
- **左栏宽度**是 CSS 变量 `--side-w`。改它之后要同步 `@media(max-width:860px)` 那个断点 ——
  两栏最小总宽是 `--side-w + 520 + gap 12 + 内边距 36`，断点写小了会让播放区右边被裁掉。
  （媒体查询里不能用 `var()`，所以是手写数字。）
- **图文贴换图**（`setPoster()`）有两条铁律，缺一条就会出问题。`<img>` 换 `src` 的写法对比：

  | 写法 | 问题 |
  |---|---|
  | 只写 `poster.src = url` | 新图在路上时，屏幕上留着的还是**上一条**图文那张图（标题已切、画面没切） |
  | 先 `src = ""` 再赋新值 | 浏览器认为「没有可用图像」，画面立刻变空 —— 本地中转实测每张 ~700ms，就是 700ms 黑屏 |
  | 先用游离 `Image()` 下载 + 解码，`onload` 里再赋 `src` | ✅ 解码过的图已在内存缓存，赋值同步出画，既不黑也不残留 |

  **铁律一：只在 `onload` 里赋 `poster.src`。** `onerror` 绝不能赋（旧代码 `onerror` 和
  `onload` 共用一个回调，等于图还没到手就把 URL 写上去了）。失败走重试一次 → 还失败跳下一张。

  **铁律二：poster 的「可见」也必须门控在解码之后。** 这条不显然 —— 光做铁律一还不够：
  `.show-image` 一加上 poster 就可见，而那时它身上的图可能还没解码完，
  **只要处于「可见但图没准备好」，Chrome 就在元素左上角画破图占位**（那个小图标）。
  所以换图的空档要把 poster 藏起来，等 `poster.decode()` 完成再显示。
  代价是换图时有几帧黑场（解码很快，基本看不见），换来的是那个占位图标永远不会出现。

  ⚠️ **但「藏 poster」必须用一个独立的类（`.poster-wait`），绝不能去摘 `.show-image`。**
  因为 `.show-image` 是**一个类管两件事**：`.phone.show-image .poster{display:block}` 和
  `.phone.show-image video{display:none}`。摘掉它，video 那条 `display:none` 也一起失效 ——
  video 元素里留着的**上一次播放的那一帧**就会在空档里露出来
  （现象：同一条图文内图片与图片之间闪出之前的视频）。
  正确做法：`.show-image` 在整条图文期间**始终挂着**（video 全程被压住），
  poster 的临时隐藏交给 `.phone.show-image.poster-wait .poster{display:none}`。

  配套的 **`posterToken`**：`stopImages()` 每调一次就 +1，所有在途回调（翻页定时器 /
  预载 `onload` / `onerror`）回来先对号，对不上直接丢弃。否则用户在图片下载途中切走，
  旧条目的回调会把新条目的画面改掉。
  顺带把图文的停留计时改成「从真正显示出来那一刻起算」，不再是「从发请求起算」。
- **头图预载 + 组内预载**：`prefetch()` 解析完后 3 条元信息后，顺手 `preloadHead()` 把图文条目的第一张
  下载 + 解码一次（`preloadImage()` 用 `preloaded` 集合去重，只在成功时记账）。
  另外 `showImages()` 每显示一张就 `preloadNextInGroup(item, idx)` 把**后面两张**也预载掉。
  - 两条都要，因为它们解决的是不同的切换路径：只预载头图的话，**组内**第 2 张起
    从来没被预载过，翻到它们时要现下（实测几百毫秒，现象就是"图片之间闪一下空白"）。
  - 实测（假后端故意加 600ms 下载耗时）：补上组内预载后，除冷启动第一张（622ms）之外，
    每次组内翻页的空档都是 **0~6ms**，跨条目切下一条是 0~1ms。
  - 为什么预载 2 张而不是更多：每张默认停留 3 秒，足够下完，再多就是白占带宽。
- **图文背景音乐**用 `<audio id="bgm" loop hidden>`，和 poster 同一个父容器。
  - `hidden` 不能省：`.phone` 里可见的空 `<audio>` 会撑出高度。
  - 播放/停止是 `playPosterMusic()` / `stopPosterMusic()`。**停的时候必须连 `src` 一起
    `removeAttribute` + `load()`**，否则它会继续下载、也可能在切到视频后接着响。
  - 收到「自动播放」开关管（和视频一致）；被自动播放策略拦时静默吞掉，不刷屏。
  - 只对图文生效；视频条目不碰它。
  - 实测（headless Chrome）：图文时 `paused=false`、`loop=true`；切到视频后 `paused=true`
    且 `src` 已清空 —— 状态机是对的。
  - `item.musicFrom` 区分音源（`music` = 原声直链 / `video-audio` = 商业曲兜底），
    日志里据此标一句，免得以后觉得"怎么慢了一拍"却想不起原因。
- **切到视频时要 `poster.removeAttribute("src")`**：`.poster` 平时靠 CSS `display:none` 藏着，
  但再切回任何图文时 `.show-image` 一加上它就立刻可见。所以离开图文时必须把图一起丢掉。
  同理 `<video>` 拿不到流时要 `dropVideoSource()` 摘掉源，否则它也会在同一个角落画坏媒体图标。

## 更新日志

- **左栏四个开关都会记住了**：连播 / 自动播放 / 播完重洗 / 文案，键名一律
  `tlk_opt_<名字>`（`continue` / `autoplay` / `loop` / `caption`），存 `"1"`/`"0"`；
  **没存过（`null`）时保持 HTML 里写死的默认勾选状态**，所以以后改默认值不用动迁移逻辑。
  读取集中在一个 `restoreOpts()` 里，并且在**启动那一段之前**调用 —— 因为
  `opt-autoplay` 决定恢复队列后是否自动开播、`opt-continue` 决定 `video.loop`、
  `opt-caption` 决定文案和遮罩的显隐，晚一步都会「先按默认值闪一下」。
  `restoreOpts()` 里顺手把副作用落实（`applyContinueOpt()` / `applyCaptionOpt()`），
  所以原来 `applyContinueOpt()` 在启动时的单独调用已经不需要了。
- **修「同一条图文内，图片与图片之间会闪出短暂空白」**：空档＝新图的**下载时间**
  （实测解码只要 8ms，下载要几百毫秒）。根因是只预载了各条图文的**头图**，
  组内第 2 张起从没预载过。改法：`showImages()` 每显示一张就把后面两张也预载掉
  （`preloadNextInGroup()`）。实测补上之后，除冷启动第一张外每次组内翻页空档 0~6ms。
- **`/api/stream` 对图片放行缓存**：抖音图片 CDN 返回 `cache-control: max-age=31536000`
  （按 URL 不可变），而这里原来一刀切成 `no-store`，等于让浏览器每次换图都重新下载。
  现在按 content-type 判断：**图片**沿用上游的缓存头（只在成功响应上放行，
  403/404 绝不缓存），**视频/音频**继续 `no-store`（直链有时效）。
  注：实测这一条不是空档的主因（预载已经消化了大部分），但方向是对的，能省掉重复请求。
- **图文的模糊背景**：原来只有视频有那圈模糊底色，图文是纯黑。现在两者共用同一套取色
  （`drawAmbientFrom()`），图文在**每张图显示出来时**重新取样，所以背景跟着当前这张图的配色走。
  取样点必须在 `poster.decode()` 之后，否则 `naturalWidth` 还是 0、取不到色。
- **修「同一条图文内，图片与图片之间会闪出之前的视频」**：这是上一版修破图图标时**引入**的。
  为了藏掉 poster，我当时摘了 `.show-image`；但那个类同时管着
  `.phone.show-image video{display:none}`，一摘 video 就露出来了，
  显示的是它里面留着的上一帧。改法见「铁律二」下面的 ⚠️：
  新增独立的 `.poster-wait` 只管 poster，`.show-image` 整条图文期间不再摘。
- **图文贴会放背景音乐了**：图文没有音轨，抖音给的是 `music.play_url`（`ies-music/*.mp3`，
  实测不需要 Referer）。服务端 `musicOf()` 把它转成本地中转地址，前端用 `<audio loop>`
  在整组图停留期间**循环**放（`music.duration` 常常只有十几秒，比一组图的停留时间短），
  切走立刻停并清源。需要把 `douyinstatic.com` 加进 `ALLOWED_CDN`，否则会被 403 挡掉。
- **商业曲图文也能出声了（同一功能的补丁）**：上一版只认 `music.play_url`，而**有版权的商业曲
  接口不给地址**（`url_list` 是空数组），这类图文于是全静音 —— 用户报的"没效果"就是这个。
  兜底改用图文贴自带的 `video.play_addr`：它其实是**纯音频轨**（只有 `soun`/`mp4a`，
  没有视频轨），实测 206 / `audio/mp4` 能播。代价是文件大得多（8.2MB vs 234KB），
  日志里会标「（版权曲，取自作品音轨）」。
  判断仍然只看"地址存不存在"，**不是** `is_use_music`（原声是 `false` 却照样有地址）。
- **修「换图时左上角冒出一个破图小图标」**：那个图标是 Chrome 的 broken-image 占位，
  出现在**「poster 可见、但图还没准备好」**的窗口期 —— 所以你看到的是「图片显示出来之前有，
  显示出来就没了」。改法见上面「铁律一 / 铁律二」：只在解码成功后赋 `src`，
  并且把 poster 的可见性也门控在解码之后。附带把 `onerror` 从「照样赋 src」改成
  「重试一次 → 跳过下一张 → 整组失败才给一行文案」。
- **修「图文 → 视频 → 下一个图文」会显示上一个图文那张图**：同一个窗口期的另一半。
  改法见上面 `setPoster()` 那一节：先下载解码再赋 `src`，外加 `posterToken` 作废在途回调、
  离开图文时清掉 `src`。
  这两个坑的判据都只能靠人眼复核（桩 DOM 里没有渲染，结构上抓不到）：
  改换图逻辑后手测「图文 → 视频 → 下一个图文」，并留意画面左上角有没有小图标。
- **左栏面板间距 26px → 8px**：原因是两条规则在叠加 —— 父容器 `main>section` 的 `gap:12px`
  加上 `.panel+.panel` 的 `margin-top:14px`。flex 的 `gap` 已经管住了间距，margin 那条纯属多余，已删。
- **左栏宽度 128px → 256px**，抽成 `--side-w` 变量；窄屏断点 760px → 860px。
- **左栏可收起**：页头「收起左栏 / 展开左栏」，状态记在 `localStorage["tlk_side_off"]`。
  按钮放页头而不是左栏里 —— 收起来之后它必须还在，否则没法展开回来。
  收起状态必须在启动那次尺寸测量**之前**落到 DOM 上，否则横屏视频会按旧宽度算错。
- **增量更新**：重新导入完整列表时只追加新 ID，不再把已看记录清零。
- **从 TXT / JSON 恢复**：localStorage 被清掉后不用重采。JSON 走 `ids` 数组，
  TXT 直接全文正则捞 ID，与当前集合合并（不覆盖）。
- **图文贴**：用 `<img>` 轮播展示，双击可全屏。
- **播放路径从官方 iframe 播放器换成 `aweme/detail` + 原生 `<video>`**：原因是官方播放器写死
  `autoplay=0`，做不了自动连播，也没有视频时长。
