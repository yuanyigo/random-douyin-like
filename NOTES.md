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

跑测试：

```powershell
cd collector
node smoke-test.mjs                                  # 22 项，含从备份恢复的路径
node smoke-test.mjs "路径\douyin-likes-xxx.txt"       # 额外校验一份真实导出文件
```

## 前端实现备忘

- **应用外壳布局**：`html,body{height:100%}` + `body{display:flex;flex-direction:column;overflow:hidden}`，
  整页永不滚动，左栏在它自己内部滚。这样 `stage.clientHeight` 是稳定的，
  播放区尺寸可以直接量，不会出现「内容撑高 stage → stage 又决定内容」的循环。
- **播放区尺寸按朝向分开处理**：横屏让盒子贴合视频比例（同时撑满宽高、不裁切），
  竖屏铺满宽度 + 占满可用高度，两侧留白给模糊背景。
- **模糊背景**用一张 64×36 的 canvas，在视频第一帧就绪时取色，CSS 放大 + 重模糊。
  视频流经本地服务同源中转，所以 `drawImage` 不会污染 canvas。
- **方向键必须挂在捕获阶段**：原生 `<video controls>` 在它的 shadow DOM 里自己处理方向键/空格，
  冒泡阶段挂监听器时事件冒上来已经被处理完了。捕获阶段 + `stopPropagation` 才能拦住。
- **切换视频时不要碰 `controls` 属性**：改 `src` 会触发一次 `pause`，Chrome 一见暂停就显示控制条，
  于是进度条一闪、文案被顶上去。现在只在第一次 `mousemove` / `pointerdown` 时才恢复 `controls`。
- **`<video>` 的 `background` 必须是 `transparent`**：`object-fit:contain` 时元素盒子仍是满的，
  设成 `#000` 会把底下的模糊背景整个盖住。
- **左栏宽度**是 CSS 变量 `--side-w`。改它之后要同步 `@media(max-width:860px)` 那个断点 ——
  两栏最小总宽是 `--side-w + 520 + gap 12 + 内边距 36`，断点写小了会让播放区右边被裁掉。
  （媒体查询里不能用 `var()`，所以是手写数字。）

## 更新日志

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
