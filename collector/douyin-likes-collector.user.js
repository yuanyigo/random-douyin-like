// ==UserScript==
// @name         抖音点赞采集器 · 大批量模式（random-douyin-like）
// @namespace    random-douyin-like
// @version      2.0.0
// @description  一次性采集抖音「喜欢」列表的全部视频 ID，支持断点续采与大列表导出
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 为什么 @match 是全站而不是只匹配 /user/*：
 *   抖音是 SPA。如果你从首页点头像进个人主页，那是内部跳转、页面不重新加载，
 *   Tampermonkey 不会重新注入脚本，面板就永远不出现。
 *   全站注入可以保证：不管你怎么进到「喜欢」页，脚本都已经在了。
 *   面板会自己判断当前路由，不在个人主页时自动折叠并提示。
 */

/*
 * 两种用法，脚本内容完全一样：
 *   【A】油猴脚本（推荐）  Tampermonkey → 添加新脚本 → 粘贴全文 → 保存
 *   【B】Console（零安装） F12 → Console → 先手打 allow pasting 回车 → 粘贴全文 → 回车
 *
 * 大批量模式的三个要点：
 *   1. 以「网络响应捕获」为主，不再依赖 DOM 渲染 —— DOM 只做每 10 轮的兜底扫描
 *   2. 自动存盘到 localStorage，标签页崩溃/刷新后可以继续，已采到的 ID 不会丢
 *   3. 自适应调速：有数据就加速，连续没数据就减速，最终判定到底
 *
 * ⚠️ 采集期间务必让标签页保持在前台可见。
 *    Chrome/Edge 会把后台标签的定时器限流到每分钟一次，几万条会永远跑不完。
 */

(function () {
  "use strict";

  // ------------------------------------------------------------ 配置
  const CONFIG = {
    startDelay: 1200,   // 初始每轮等待（ms）
    minDelay: 1000,     // 最快（有数据时）—— 别更快，滚过头会错过"加载哨兵"
    maxDelay: 3500,     // 最慢（没数据时，用来确认是不是真到底了）
    idleRounds: 8,      // 连续多少轮无新增 → 先尝试"回滚重试"，而不是直接判定到底
    maxJiggles: 6,      // 最多重试几次，之后才认定到底
    maxRounds: 20000,   // 硬上限
    domScanEvery: 4,    // 每几轮做一次 DOM 兜底扫描（必须 < idleRounds）
    saveEvery: 5,       // 每几轮存盘一次
    ratelimitAfter: 3,  // 连续几轮拿到空响应就提示可能被限流
    cooldownMs: 90000,  // 回滚也无效时，先冷却这么久再重试（对付限流）
    maxCooldowns: 3,    // 最多冷却重试几次
    sniffSeconds: 15,   // 诊断模式监听网络请求的秒数
  };

  const LS_KEY = "tlk_collector_v2";

  // 防重复注入
  if (window.__TLK_COLLECTOR__) {
    window.__TLK_COLLECTOR__.show();
    return;
  }

  // ------------------------------------------------------------ 状态
  const ids = new Set();
  let running = false;
  let scroller = null;
  let round = 0;
  let favResponses = 0;      // 见到的 /aweme/favorite/ 响应数
  let emptyStreak = 0;       // 连续拿到空列表的次数
  let startedAt = 0;
  let lastHasMore = null;    // 接口返回的 has_more：0 = 服务端明确说"没有更多了"
  let lastCursor = null;     // 最后一次见到的 max_cursor，用于判断游标是否还在推进
  let cooldowns = 0;         // 已经"冷却重试"过几次

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isAwemeId = (v) => typeof v === "string" && /^\d{15,25}$/.test(v);
  const fmt = (n) => n.toLocaleString("en-US");

  // ------------------------------------------------------------ 持久化
  function saveState(reason) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: 2,
        ids: [...ids].join("\n"),
        count: ids.size,
        rounds: round,
        savedAt: Date.now(),
        reason: reason || "auto",
      }));
      return true;
    } catch (e) {
      note("存盘失败（localStorage 配额可能满了）：" + e.message);
      return false;
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || typeof d.ids !== "string") return null;
      const arr = d.ids.split("\n").filter(isAwemeId);
      arr.forEach((x) => ids.add(x));
      return { count: ids.size, savedAt: d.savedAt, rounds: d.rounds || 0 };
    } catch (e) {
      return null;
    }
  }

  function clearSaved() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ ① 网络层（主力）
  const AWEME_API = /\/aweme\//;
  const FAVORITE_API = /\/aweme\/v1\/web\/aweme\/favorite\//;

  // 诊断用：记录见过的所有接口 URL（不只是匹配 aweme 的），用来定位真实接口
  const seenUrls = new Map();
  function recordUrl(u) {
    if (!u) return;
    const key = String(u).split("?")[0].slice(0, 150);
    if (!key) return;
    seenUrls.set(key, (seenUrls.get(key) || 0) + 1);
  }

  // 兼容 fetch("url") / fetch(new Request(...)) / fetch(new URL(...))
  // —— 之前只判断 typeof === "string"，遇到 URL 对象会漏掉
  function urlOf(a) {
    try {
      if (typeof a === "string") return a;
      if (a && typeof a.url === "string") return a.url;
      if (a && typeof a.href === "string") return a.href;
    } catch (e) { /* ignore */ }
    return "";
  }

  function deepCollect(node, depth) {
    if (!node || typeof node !== "object" || depth > 14) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) deepCollect(node[i], depth + 1);
      return;
    }
    const direct = node.aweme_id || node.awemeId;
    if (isAwemeId(direct)) ids.add(direct);
    for (const k in node) {
      if (k === "aweme_id" || k === "awemeId") continue;
      const v = node[k];
      if (v && typeof v === "object") deepCollect(v, depth + 1);
    }
  }

  /** 从响应里判断这一页是不是空的，用来识别限流 / 翻到底 */
  function looksEmpty(json) {
    if (!json || typeof json !== "object") return true;
    const list = json.aweme_list || json.data;
    if (Array.isArray(list)) return list.length === 0;
    return false;
  }

  function handlePayload(json, url) {
    const before = ids.size;
    deepCollect(json, 0);
    const grew = ids.size - before;

    if (url && FAVORITE_API.test(url)) {
      favResponses++;

      // has_more 是服务端对"还有没有下一页"的明确回答：
      //   0 → 确实到底了；1 → 还有更多。这比"数字不涨了"可靠得多。
      if (json && typeof json.has_more !== "undefined") {
        const hm = Number(json.has_more);
        if (hm === 0 && lastHasMore !== 0) {
          note("✅ 服务端返回 has_more=0 —— 明确表示「喜欢」列表已到底，后面没有了", true);
        }
        lastHasMore = hm;
      }

      // 游标是否还在推进，也能区分"到底"和"卡住"
      if (url) {
        const m = String(url).match(/max_cursor=(\d+)/);
        if (m) {
          if (lastCursor !== null && m[1] === lastCursor) {
            // 游标没动，说明这一页是重复的
          }
          lastCursor = m[1];
        }
      }

      if (looksEmpty(json)) {
        emptyStreak++;
        if (emptyStreak === CONFIG.ratelimitAfter) {
          note("⚠ 连续 " + emptyStreak + " 次拿到空列表：可能被限流了，也可能真的翻到底了", true);
        }
      } else {
        emptyStreak = 0;
      }
    }
    if (grew) refresh();
    return grew;
  }

  function hookNetwork() {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const url = urlOf(args[0]);
          recordUrl(url);
          if (AWEME_API.test(url)) {
            p.then((res) => {
              try {
                res.clone().json()
                  .then((j) => handlePayload(j, url))
                  .catch(() => {});
              } catch (e) { /* ignore */ }
            }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return p;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__tlkUrl = String(url);
          recordUrl(this.__tlkUrl);
        } catch (e) { /* ignore */ }
        return origOpen.call(this, method, url, ...rest);
      };

      XHR.prototype.send = function (...args) {
        try {
          this.addEventListener("load", function () {
            try {
              const url = this.__tlkUrl || "";
              if (!AWEME_API.test(url)) return;
              const rt = this.responseType;
              let data = null;
              if (rt === "" || rt === "text") data = JSON.parse(this.responseText);
              else if (rt === "json") data = this.response;
              if (data) handlePayload(data, url);
            } catch (e) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
        return origSend.apply(this, args);
      };
    }
  }

  // ------------------------------------------------------------ ② DOM 层（兜底，低频）
  function harvestDom() {
    const before = ids.size;
    const links = document.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute("href") || "";
      let m = href.match(/\/video\/(\d{15,25})/);
      if (!m) m = href.match(/modal_id=(\d{15,25})/);
      if (m) ids.add(m[1]);
    }
    const nodes = document.querySelectorAll("[data-id]");
    for (let i = 0; i < nodes.length; i++) {
      const v = (nodes[i].getAttribute("data-id") || "").trim();
      if (isAwemeId(v)) ids.add(v);
    }
    if (ids.size !== before) refresh();
    return ids.size - before;
  }

  // ------------------------------------------------------------ 滚动
  function isWindowScroller(s) {
    return s === document.scrollingElement || s === document.documentElement || s === document.body;
  }

  function findScroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 300) return se;
    let best = null, bestH = 0;
    const all = document.querySelectorAll("div, main, section");
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      let st;
      try { st = getComputedStyle(d); } catch (e) { continue; }
      if (!/(auto|scroll)/.test(st.overflowY)) continue;
      if (d.scrollHeight > d.clientHeight + 200 && d.scrollHeight > bestH) {
        bestH = d.scrollHeight; best = d;
      }
    }
    return best || se;
  }

  // 优先用 scrollIntoView 定位"最后一张卡片"，而不是自己去设 scrollTop：
  //   1. 它会自动处理嵌套滚动容器 —— 不用猜到底哪个元素在滚（这正是之前失败的原因）
  //   2. 保证末尾内容留在视口内，"加载更多"的哨兵更容易被持续触发
  function doScroll() {
    const cards = document.querySelectorAll('a[href*="/video/"]');
    if (cards.length) {
      try {
        // 用 center 而不是 end：end 会把最后一张卡片贴到视口底部，
        // 紧跟其后的"加载哨兵"就落在折线以下、触发不了加载。
        // center 能保证卡片下方留出空间，让哨兵留在视口里。
        cards[cards.length - 1].scrollIntoView({ block: "center", behavior: "auto" });
        return true;
      } catch (e) { /* 落到下面的兜底 */ }
    }
    if (!scroller) {
      scroller = findScroller() || document.scrollingElement || document.documentElement;
    }
    const vh = scroller.clientHeight || window.innerHeight || 800;
    const step = Math.round(vh * 0.85);
    if (isWindowScroller(scroller)) window.scrollBy(0, step);
    else scroller.scrollTop += step;
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
  }

  // 页面总高度：比"ID 数量"更灵敏的进度信号。
  // 列表在加载但内容还没被解析出来时，高度会先涨。
  function docHeight() {
    const se = document.scrollingElement || document.documentElement;
    let h = se ? se.scrollHeight : 0;
    if (scroller && scroller.scrollHeight > h) h = scroller.scrollHeight;
    return h;
  }

  // 卡住时的自救：先往回滚两屏，再滚回底部，把加载哨兵重新拽进视口。
  // 这解决"滚过头 → 哨兵跑到视口上方 → 再也不加载"的死局。
  async function jiggle() {
    const vh = window.innerHeight || 800;
    try {
      if (isWindowScroller(scroller || document.scrollingElement)) {
        window.scrollBy(0, -Math.round(vh * 2));
      } else if (scroller) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - vh * 2);
      }
    } catch (e) { /* ignore */ }
    await sleep(600);
    doScroll();
    await sleep(600);
  }

  // ------------------------------------------------------------ 主流程
  async function run() {
    if (running) return;

    if (document.hidden) {
      note("⚠ 标签页在后台。浏览器会把定时器限流到每分钟一次，请切到前台再开始。");
    }

    running = true;
    setBusy(true);
    state("采集中…");
    startedAt = Date.now();
    emptyStreak = 0;

    scroller = findScroller() || document.scrollingElement || document.documentElement;
    const winScroll = isWindowScroller(scroller);
    note(winScroll ? "滚动方式：window" : "滚动方式：内部容器");

    try {
      if (winScroll) window.scrollTo(0, 0);
      else scroller.scrollTop = 0;
    } catch (e) { /* ignore */ }
    await sleep(600);

    // 脚本是页面加载完之后才贴进来的，首屏的接口请求没被钩到。
    // 所以先立刻用 DOM 扫一遍，把已经渲染出来的内容抓走。
    const pre = harvestDom();
    if (pre > 0) note("开始前先从页面扫到 " + pre + " 个（脚本贴上之前就已加载的首屏内容）");

    let last = ids.size;
    let idle = 0;
    let delay = CONFIG.startDelay;
    let stuckScroll = 0;
    let lastScrollPos = -1;
    let lastHeight = docHeight();
    let jiggles = 0;
    const startCount = ids.size;
    const startRound = round;

    while (running && round < CONFIG.maxRounds) {
      round++;

      // 网络捕获是主力，DOM 每 N 轮兜底
      if (round % CONFIG.domScanEvery === 0) harvestDom();

      const grew = ids.size - last;
      last = ids.size;

      // 页面高度也算进度：列表在加载但还没解析出内容时，高度会先涨
      const h = docHeight();
      const heightGrew = h > lastHeight + 4;
      lastHeight = h;

      // 自适应调速
      if (grew > 0 || heightGrew) {
        idle = 0;
        delay = Math.max(CONFIG.minDelay, delay - 120);
      } else {
        idle++;
        delay = Math.min(CONFIG.maxDelay, delay + 250);
      }

      updateStats(grew, delay);

      // 滚动位置到底动没动？不动就说明找错滚动容器了
      let pos = 0;
      try { pos = winScroll ? window.scrollY : scroller.scrollTop; } catch (e) { /* ignore */ }
      if (pos === lastScrollPos) {
        stuckScroll++;
        if (stuckScroll === 4) {
          note("滚动位置不再变化（可能列表已加载完，也可能找错滚动容器了）");
        }
      } else {
        stuckScroll = 0;
      }
      lastScrollPos = pos;

      if (idle >= CONFIG.idleRounds) {
        // 1) 服务端明确说没有下一页了 → 直接结束，不用再折腾
        if (lastHasMore === 0) {
          note("服务端返回 has_more=0，确认到底，停止采集");
          break;
        }

        // 2) 先试「回滚再下滚」，把加载哨兵重新拽进视口
        if (jiggles < CONFIG.maxJiggles) {
          jiggles++;
          idle = 0;
          note("连续无新增，第 " + jiggles + "/" + CONFIG.maxJiggles + " 次尝试「回滚再下滚」重新触发加载…");
          await jiggle();
          continue;
        }

        // 3) 回滚也无效 → 很可能是被限流了，冷一段时间再试
        if (cooldowns < CONFIG.maxCooldowns) {
          cooldowns++;
          jiggles = 0;
          idle = 0;
          const secs = Math.round(CONFIG.cooldownMs / 1000);
          note("回滚无效，疑似被限流。冷却 " + secs + " 秒后重试（第 " +
               cooldowns + "/" + CONFIG.maxCooldowns + " 次）", true);
          for (let s = secs; s > 0 && running; s -= 5) {
            state("冷却中…还有 " + s + " 秒（疑似限流，等它恢复）");
            await sleep(5000);
          }
          if (!running) break;
          await jiggle();
          continue;
        }

        // 4) 各种手段都用完了
        if (ids.size === startCount) {
          note("注意：整轮下来一个都没采到，说明接口没被钩住或滚动没触发加载。点「诊断」我来定位。", true);
        }
        note("多次重试 + 冷却后仍无新增，判定到底（但没见到 has_more=0，无法百分百确认）", true);
        break;
      }

      doScroll();

      if (round % CONFIG.saveEvery === 0) saveState("auto");

      await sleep(delay);
    }

    running = false;
    setBusy(false);
    saveState("finish");

    const gained = ids.size - startCount;
    const roundsUsed = round - startRound;
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    state("完成：共 " + fmt(ids.size) + " 个");
    note(
      "结束。本轮新增 " + fmt(gained) + " 个，用了 " + roundsUsed + " 轮 / " + mins + " 分钟" +
      "，见到 " + fmt(favResponses) + " 个 favorite 响应"
    );
    if (gained === 0 && startCount > 0) {
      note("本轮一个都没新增，说明上次已经采到底了，或者被限流了。", true);
    }
    note("点「复制 ID 列表」或「下载」导出。下次打开会自动载入已采结果。", true);
  }

  function stop() {
    if (!running) return;
    running = false;
    setBusy(false);
    saveState("stop");
    state("已停止：共 " + fmt(ids.size) + " 个");
    note("已停止并存盘，共 " + fmt(ids.size) + " 个");
  }

  // ------------------------------------------------------------ 诊断
  // 用途：一个都没采到时，区分「接口没钩住」还是「滚动没触发加载」
  async function diagnose() {
    if (running) { note("请先停止采集再诊断"); return; }

    seenUrls.clear();
    note("=== 诊断开始 ===");
    note("地址：" + location.href);
    note("页面可见：" + (!document.hidden) + "（在后台会被浏览器限速）");

    const sc = findScroller() || document.scrollingElement || document.documentElement;
    const win = isWindowScroller(sc);
    const pos = win ? window.scrollY : sc.scrollTop;
    note("滚动容器：" + (win ? "window" : (sc.tagName + " " + String(sc.className).slice(0, 36))));
    note("scrollTop=" + pos + " scrollHeight=" + sc.scrollHeight + " clientHeight=" + sc.clientHeight);
    note("DOM 中 /video/ 链接数：" + document.querySelectorAll('a[href*="/video/"]').length);
    note("已采集 ID：" + ids.size);

    note("👉 接下来 " + CONFIG.sniffSeconds + " 秒，请【手动往下滚 5~10 屏】，让列表加载", true);

    let left = CONFIG.sniffSeconds;
    state("诊断中…还剩 " + left + " 秒，请手动往下滚");
    const timer = setInterval(() => {
      left--;
      if (left > 0) state("诊断中…还剩 " + left + " 秒，请手动往下滚");
    }, 1000);

    await sleep(CONFIG.sniffSeconds * 1000);
    clearInterval(timer);

    const found = [...seenUrls.entries()].sort((a, b) => b[1] - a[1]);
    const aweme = found.filter(([u]) => AWEME_API.test(u));
    const fav = aweme.filter(([u]) => /favorite/.test(u));

    note("--- 结果 ---");
    note("见到 " + found.length + " 个不同接口，其中 /aweme/ 相关 " + aweme.length + " 个");

    if (fav.length) {
      note("✅ 找到 favorite 接口：" + fav[0][0], true);
      note("（说明钩子是好的，问题在别处 —— 请把下面截图发我）", true);
    } else if (aweme.length) {
      note("⚠ 有 /aweme/ 接口但没有 favorite，喜欢列表可能走了别的路径：", true);
      aweme.slice(0, 12).forEach(([u, c]) => note("  " + c + "× " + u));
    } else if (found.length) {
      note("❌ 一个 /aweme/ 接口都没有。这轮实际发生的请求（前 20 个）：", true);
      found.slice(0, 20).forEach(([u, c]) => note("  " + c + "× " + u));
    } else {
      note("❌ 一个请求都没记录到。", true);
      note("那 15 秒里页面完全没发请求 → 滚动没有触发加载。", true);
      note("要么找错了滚动容器，要么这个列表是一次性加载完的。", true);
    }

    note("--- 诊断结束 --- 请把日志截图发我");
    state("诊断完成，见日志");
    console.log("[抖音点赞采集器·诊断] 完整接口清单：", found);
  }

  // ------------------------------------------------------------ 导出
  function textOut() { return [...ids].join("\n"); }

  async function copyOut() {
    if (!ids.size) { note("还没有采集到内容"); return; }
    const t = textOut();
    try {
      await navigator.clipboard.writeText(t);
      note("已复制 " + fmt(ids.size) + " 个 ID 到剪贴板", true);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); note("已复制 " + fmt(ids.size) + " 个 ID", true); }
      catch (e2) { note("复制失败（数据量大时剪贴板会失败），请用「下载」"); }
      ta.remove();
    }
  }

  function download(kind) {
    if (!ids.size) { note("还没有采集到内容"); return; }
    const arr = [...ids];
    let blob, name;
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === "json") {
      blob = new Blob([JSON.stringify({
        source: "douyin-likes",
        collectedAt: new Date().toISOString(),
        pageUrl: location.href,
        count: arr.length,
        ids: arr,
      }, null, 2)], { type: "application/json" });
      name = "douyin-likes-" + stamp + ".json";
    } else {
      blob = new Blob([arr.join("\n")], { type: "text/plain" });
      name = "douyin-likes-" + stamp + ".txt";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    note("已下载 " + name + "（" + fmt(arr.length) + " 个）", true);
  }

  // ------------------------------------------------------------ 导入恢复
  // localStorage 是按「浏览器 + 用户配置 + 站点」隔离的，换浏览器、无痕、
  // 清过站点数据都会让它变空。下载过的 TXT / JSON 才是唯一可靠的备份，
  // 所以面板得能把备份读回来 —— 否则一被清就只能从头再采一遍。
  // 从备份文本里提取 ID：JSON 的 ids 数组优先，读不出就退化成「全文正则捞 ID」，
  // 这样 TXT、复制出来的片段、甚至整页 HTML 都能吃。
  function parseIdsFromText(text) {
    let found = [];
    try {
      const p = JSON.parse(text);
      if (p && Array.isArray(p.ids)) found = p.ids;
    } catch (e) { /* 不是 JSON，按纯文本处理 */ }
    if (!found.length) found = String(text).match(/\d{15,25}/g) || [];
    return found.map((x) => String(x).trim()).filter(isAwemeId);
  }

  // 把一份备份并进当前集合。抽出来是为了能脱离 FileReader 单测。
  function restoreFromText(text, label) {
    const found = parseIdsFromText(text);
    const before = ids.size;
    let added = 0;
    for (const v of found) {
      if (!ids.has(v)) { ids.add(v); added++; }
    }
    saveState("import");
    refresh();
    note("从 " + (label || "文本") + " 读入 " + fmt(found.length) + " 个，新增 " +
         fmt(added) + " 个，现共 " + fmt(ids.size) + " 个", true);
    if (!added) note("没有新增 —— 这些 ID 都已经在集合里了。");
    state("已恢复到 " + fmt(ids.size) + " 个");
    return { read: found.length, added, before, total: ids.size };
  }

  function importFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.json,text/plain,application/json";
    input.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) { input.remove(); return; }
      const rd = new FileReader();
      rd.onload = () => { input.remove(); restoreFromText(String(rd.result || ""), f.name); };
      rd.onerror = () => { input.remove(); note("读取失败：" + f.name, true); };
      rd.readAsText(f);
    });

    input.click();
  }

  // ------------------------------------------------------------ UI
  let elPanel, elCount, elStats, elBtnRun, elBtnStop, elLog, elWarn, elResume;
  const logLines = [];

  function buildUI() {
    const style = document.createElement("style");
    style.textContent = `
      #tlk-panel{position:fixed;right:18px;bottom:18px;z-index:2147483646;width:296px;
        background:#141418;color:#e8e8ee;border:1px solid #2a2a33;border-radius:11px;
        font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
        box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden}
      #tlk-panel .hd{display:flex;align-items:center;gap:8px;padding:9px 11px;
        background:#1b1b21;border-bottom:1px solid #2a2a33;cursor:pointer;user-select:none}
      #tlk-panel .hd b{font-size:12px;flex:1}
      #tlk-panel .dot{width:7px;height:7px;border-radius:50%;background:#5a5a68;flex:none}
      #tlk-panel.busy .dot{background:#fe2c55;animation:tlkp 1s infinite}
      @keyframes tlkp{50%{opacity:.25}}
      #tlk-panel .bd{padding:11px}
      #tlk-panel.collapsed .bd{display:none}
      #tlk-count{font-size:23px;font-weight:700;color:#fe2c55;font-family:ui-monospace,monospace;line-height:1.2}
      #tlk-count span{font-size:11px;color:#8b8b99;font-weight:400;margin-left:5px}
      #tlk-stats{color:#8b8b99;font-size:10.5px;font-family:ui-monospace,monospace;margin:3px 0 4px}
      #tlk-status{color:#8b8b99;font-size:11px;margin:0 0 9px;min-height:16px}
      #tlk-panel button{width:100%;font:inherit;font-size:12px;color:#e8e8ee;background:#1b1b21;
        border:1px solid #2a2a33;border-radius:7px;padding:7px;cursor:pointer;margin-bottom:6px}
      #tlk-panel button:hover:not(:disabled){background:#23232b;border-color:#3d3d4a}
      #tlk-panel button.pri{background:#fe2c55;border-color:#fe2c55;color:#fff;font-weight:600}
      #tlk-panel button.pri:hover:not(:disabled){background:#ff4569}
      #tlk-panel button:disabled{opacity:.4;cursor:not-allowed}
      #tlk-panel .two{display:flex;gap:6px}
      #tlk-log{max-height:110px;overflow:auto;background:#0e0e12;border:1px solid #2a2a33;
        border-radius:6px;padding:6px 8px;font:10.5px/1.6 ui-monospace,monospace;color:#8b8b99;
        white-space:pre-wrap;word-break:break-all}
      #tlk-warn{display:none;background:#241f10;border:1px solid #5c4e1e;color:#f1c40f;
        border-radius:6px;padding:6px 8px;font-size:10.5px;margin-bottom:8px}
      #tlk-resume{display:none;background:#10241a;border:1px solid #1e5c39;color:#2ecc71;
        border-radius:6px;padding:6px 8px;font-size:10.5px;margin-bottom:8px}
      #tlk-resume.noload{background:#241f10;border-color:#5c4e1e;color:#f1c40f}
    `;
    document.head.appendChild(style);

    elPanel = document.createElement("div");
    elPanel.id = "tlk-panel";
    elPanel.innerHTML = `
      <div class="hd" id="tlk-hd"><span class="dot"></span><b>抖音点赞采集器 · 大批量</b><span id="tlk-toggle">▾</span></div>
      <div class="bd">
        <div id="tlk-count">0<span>个视频 ID</span></div>
        <div id="tlk-stats">等待开始</div>
        <div id="tlk-status">请确认在当前页面是「我的主页 → 喜欢」</div>
        <div id="tlk-warn">⚠ 标签页在后台，浏览器会限速到每分钟一次，请保持前台可见。</div>
        <div id="tlk-resume"></div>
        <button class="pri" id="tlk-run">开始采集</button>
        <button id="tlk-stop" disabled>停止并存盘</button>
        <button id="tlk-diag">诊断（一个都没采到时点这个）</button>
        <div class="two">
          <button id="tlk-copy">复制 ID</button>
          <button id="tlk-dltxt">下载 TXT</button>
        </div>
        <button id="tlk-dljson">下载 JSON（带元信息）</button>
        <button id="tlk-import">从 TXT / JSON 恢复</button>
        <button id="tlk-clear">清空已采数据</button>
        <div id="tlk-log"></div>
      </div>`;
    (document.body || document.documentElement).appendChild(elPanel);

    elCount = elPanel.querySelector("#tlk-count");
    elStats = elPanel.querySelector("#tlk-stats");
    elBtnRun = elPanel.querySelector("#tlk-run");
    elBtnStop = elPanel.querySelector("#tlk-stop");
    elLog = elPanel.querySelector("#tlk-log");
    elWarn = elPanel.querySelector("#tlk-warn");
    elResume = elPanel.querySelector("#tlk-resume");

    elBtnRun.addEventListener("click", run);
    elBtnStop.addEventListener("click", stop);
    elPanel.querySelector("#tlk-diag").addEventListener("click", diagnose);
    elPanel.querySelector("#tlk-copy").addEventListener("click", copyOut);
    elPanel.querySelector("#tlk-dltxt").addEventListener("click", () => download("txt"));
    elPanel.querySelector("#tlk-dljson").addEventListener("click", () => download("json"));
    elPanel.querySelector("#tlk-import").addEventListener("click", importFromFile);
    elPanel.querySelector("#tlk-clear").addEventListener("click", () => {
      if (!confirm("确定清空已采集的 " + fmt(ids.size) + " 个 ID？此操作不可撤销。")) return;
      ids.clear();
      clearSaved();
      round = 0;
      refresh();
      state("已清空");
      note("已清空并删除存盘数据");
    });
    elPanel.querySelector("#tlk-hd").addEventListener("click", () => {
      elPanel.classList.toggle("collapsed");
      elPanel.querySelector("#tlk-toggle").textContent =
        elPanel.classList.contains("collapsed") ? "▸" : "▾";
    });

    document.addEventListener("visibilitychange", () => {
      elWarn.style.display = document.hidden && running ? "block" : "none";
    });
  }

  // ------------------------------------------------------------ 路由感知
  // 抖音是 SPA，进「喜欢」页不一定会重新加载页面，所以面板要自己跟着路由走。
  function isProfilePage() {
    return /^\/user\//.test(location.pathname);
  }

  function syncPanelToRoute() {
    if (!elPanel) return;
    if (isProfilePage()) {
      elPanel.classList.remove("collapsed");
      if (!running) state(ids.size ? "已采集 " + fmt(ids.size) + " 个" : "等待开始");
    } else {
      elPanel.classList.add("collapsed");
      const t = elPanel.querySelector("#tlk-toggle");
      if (t) t.textContent = "▸";
      state("请打开「我的主页 → 喜欢」列表");
    }
  }

  function watchRoute() {
    const fire = () => setTimeout(syncPanelToRoute, 60);
    ["pushState", "replaceState"].forEach((m) => {
      const orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function (...a) {
        const r = orig.apply(this, a);
        fire();
        return r;
      };
    });
    window.addEventListener("popstate", fire);
  }

  function refresh() {
    if (!elPanel) return;
    elCount.innerHTML = fmt(ids.size) + "<span>个视频 ID</span>";
    if (!running) state(ids.size ? "已采集 " + fmt(ids.size) + " 个" : "等待开始");
  }

  function updateStats(grew, delay) {
    if (!elStats) return;
    const mins = (Date.now() - startedAt) / 60000;
    const rate = mins > 0.05 ? Math.round(ids.size / mins) : 0;
    elStats.textContent =
      "第 " + fmt(round) + " 轮 · " + delay + "ms/轮 · " +
      (rate ? fmt(rate) + " 个/分" : "—") +
      (grew ? " · +" + grew : " · 无新增");
  }

  function state(t) { if (elPanel) elPanel.querySelector("#tlk-status").textContent = t; }

  function note(t, echo) {
    const ts = new Date().toLocaleTimeString().slice(0, 8);
    logLines.push("[" + ts + "] " + t);
    if (logLines.length > 80) logLines.shift();
    if (elLog) {
      elLog.textContent = logLines.join("\n");
      elLog.scrollTop = elLog.scrollHeight;
    }
    if (echo) console.log("[抖音点赞采集器]", t);
  }

  function setBusy(b) {
    if (!elPanel) return;
    elPanel.classList.toggle("busy", b);
    elBtnRun.disabled = b;
    elBtnStop.disabled = !b;
    elBtnRun.textContent = b ? "采集中…" : "开始采集";
    elWarn.style.display = b && document.hidden ? "block" : "none";
  }

  function show() { if (elPanel) elPanel.style.display = ""; }

  // ------------------------------------------------------------ 启动
  hookNetwork();   // document-start 时 body 还不存在，先挂钩子

  function boot() {
    if (!document.body) { setTimeout(boot, 100); return; }
    if (document.getElementById("tlk-panel")) return;
    buildUI();

    const saved = loadState();
    if (saved && saved.count > 0) {
      const when = new Date(saved.savedAt).toLocaleString();
      elResume.className = "";
      elResume.style.display = "block";
      elResume.textContent = "已载入上次采集的 " + fmt(saved.count) + " 个（" + when + "）";
      state("已载入 " + fmt(saved.count) + " 个，可继续采集");
      note("载入上次结果 " + fmt(saved.count) + " 个");
    } else {
      // 之前这里是静默的：banner 不出现，用户根本不知道是「本来就没有」还是「读不出来」。
      // localStorage 是按「浏览器 + 用户配置 + 站点」隔离的，换浏览器、隐私模式、
      // 清过站点数据或用清理软件扫过，都会在这里表现为空。
      state("等待开始（没有上次数据）");
      elResume.className = "noload";
      elResume.style.display = "block";
      elResume.textContent = "未找到上次的采集数据 —— 点下面的「从 TXT / JSON 恢复」把下载过的列表读回来";
      note("未找到上次的采集数据（localStorage 里没有 " + LS_KEY + "）。", true);
      note("有下载过 douyin-likes-*.txt 的话，点「从 TXT / JSON 恢复」直接读回来，不用重采。", true);
      note("不想恢复也行：只想要新点赞的直接点「开始采集」，新的在列表最前面，滚几屏就能停。", true);
    }
    refresh();
    watchRoute();
    syncPanelToRoute();

    note("就绪。请确认当前在「我的主页 → 喜欢」列表。");
    note("只想要新增的？直接点「开始采集」——新的会并进已采集合（不清空），滚几屏就能停。");
    note("⚠ 采集期间请让本标签页保持前台可见，后台会被浏览器限速。");
    console.log("%c[抖音点赞采集器] 已加载（大批量模式）", "color:#fe2c55;font-weight:bold");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.__TLK_COLLECTOR__ = {
    show, ids, run, stop, text: textOut,
    restoreFromText, parseIdsFromText,
    get size() { return ids.size; },
    get collected() { return ids.size; },
  };
})();
