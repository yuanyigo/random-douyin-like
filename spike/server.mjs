// 抖音「随机播放点赞过的视频」—— 本地服务
//
// 播放链路（路线 B：直链 + 原生 video）：
//   1. /api/play    调抖音 web 的 aweme/detail 接口，拿到视频直链、时长、封面
//   2. /api/stream  把 CDN 视频流中转给浏览器
//      —— 因为 CDN 有防盗链，只接受 Referer: https://open.douyin.com/
//         而浏览器的 <video> 无法伪造 Referer，只能靠服务端中转
//   3. 托管前端页面 + 展开 v.douyin.com 短链
//
// 关于接口稳定性：aweme/detail 对请求头极敏感。
//   实测「完整模仿官方播放器的跨域 fetch」时成功率 6/6；
//   只带 Referer+Accept 或伪装顶层导航时 0/6。下面的 DETAIL_HEADERS 就是那套。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 5178);

const DETAIL_API = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const PLAYER_BASE = "https://open.douyin.com/player/video";

// 用真实浏览器 UA，避免被当成脚本
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ⚠️ 这套头是实测出来的关键，改动前请重跑成功率测试
const DETAIL_HEADERS = {
  "user-agent": UA,
  "referer": "https://open.douyin.com/",
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "origin": "https://open.douyin.com",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

// 只允许中转抖音自己的 CDN，避免这个接口变成开放代理
// douyinstatic.com 是音频（`ies-music/*.mp3`）的域名 —— 图文贴的背景音乐走它，
// 漏了这条会被下面 403 挡掉，表现为"图文没声音"。
const ALLOWED_CDN =
  /(^|\.)(douyinvod\.com|douyinpic\.com|douyinstatic\.com|douyin\.com|byteimg\.com|ibyteimg\.com|zjcdn\.com|snssdk\.com|bytedance\.com)$/i;

const ID_RE = /\d{15,25}/;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 从作品数据里取一个"可播的音频地址"，取不到返回 ""。
 *
 *  ⚠️ 为什么需要两条路 —— 图文贴用的曲子分两类，接口对它们的待遇完全不同：
 *
 *  1. **原声**（`music.title` 形如「@某某创作的原声」）：`music.play_url.url_list[0]`
 *     给一个 `ies-music/*.mp3`，实测 200 / audio/mpeg / 头部 "ID3"，
 *     ~200KB，**不需要 Referer、不需要 cookie**。这是最好的源。
 *
 *  2. **有版权的商业曲**（如 `music.title` = "Vagrant Poet"）：接口**只返回一个空壳**
 *     —— `play_url` 对象在，但 `url_list` 是空数组，一个地址都不给（授权限制）。
 *     只走 `play_url` 的话这类图文全部静音，而图文贴里商业曲占比很高。
 *
 *      兜底办法：图文贴响应里那个方形 `video` 字段其实是**纯音频轨**
 *      （实测前 512KB 里只有 `soun`/`mp4a`，没有 `vide`/`avc1`），
 *      即「画面定格 + 混好音」的那条流，`play_addr` 照样能播（实测 206 / audio/mp4）。
 *      代价是整条音轨的文件大得多（实测 8.2MB / 523 秒 vs 234KB / 14 秒）。
 */
function audioUrlOf(d) {
  const m = (d && d.music) || {};
  const music = (m.play_url && m.play_url.url_list && m.play_url.url_list[0]) || "";
  if (music) return { url: music, from: "music" };

  // 商业曲：退回作品自带的音频轨
  const v = (d && d.video) || {};
  const pick = v.play_addr_h264 || v.play_addr || v.play_addr_265;
  const fb = (pick && pick.url_list && pick.url_list[0]) || "";
  return { url: fb, from: "video-audio" };
}

/** 提取这条作品的背景音乐（返回的对象会展开进 /api/play 的响应里） */
function musicOf(d) {
  const { url, from } = audioUrlOf(d);
  if (!url) return {};
  const m = (d && d.music) || {};
  return {
    music: "/api/stream?u=" + encodeURIComponent(url),
    musicTitle: m.title || "",                   // 形如「@某某创作的原声」
    musicDuration: m.duration || 0,              // 秒（`music.duration` 是完整的曲长）
    musicFrom: from,                             // "music" = 原声直链；"video-audio" = 商业曲兜底
  };
}

/** 解析视频直链 + 元信息（时长/封面/尺寸） */
async function resolvePlay(id) {
  if (!ID_RE.test(id)) {
    return { ok: false, id, errMsg: "视频 ID 格式不对（应为 15~25 位数字）" };
  }
  const url = `${DETAIL_API}?aweme_id=${encodeURIComponent(id)}&aid=6383`;

  let res, text;
  try {
    res = await fetch(url, { headers: DETAIL_HEADERS });
    text = await res.text();
  } catch (e) {
    return { ok: false, id, errMsg: `请求失败：${e.message}` };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // 被风控时会返回 200 + 空 body
    return {
      ok: false, id,
      errMsg: text.length ? `接口返回非 JSON（HTTP ${res.status}）` : "接口返回空响应（可能被风控）",
    };
  }

  const d = body && body.aweme_detail;
  if (!d) {
    // 作品拿不到时，接口会带一个 filter_detail 说明原因，比笼统的"没有详情"有用得多。
    // 实测例子：{"filter_reason":"status_self_see",
    //            "detail_msg":"因作品权限或已被删除，无法观看，去看看其他作品吧"}
    const f = (body && body.filter_detail) || {};
    const why = f.detail_msg || f.notice || "";
    const reason = f.filter_reason ? "（" + f.filter_reason + "）" : "";
    return {
      ok: false, id,
      permanent: true,            // 这种是确定性失败，重试也没用，前端可直接标记
      errMsg: why ? why + reason
                  : "接口未返回作品详情（status_code=" + (body && body.status_code) + "）",
    };
  }

  // 图文贴（图集）：没有视频，只有 images[]。抖音的图文链接是 /note/{id} 而不是 /video/{id}。
  // 注意：图文通常也带一个 video 字段（封面/音乐），所以必须先看 images，不能先看 video。
  if (Array.isArray(d.images) && d.images.length) {
    const imgs = d.images
      .map((im) => ({
        url: (im.url_list && im.url_list[0]) || "",
        width: im.width, height: im.height,
      }))
      .filter((x) => x.url);
    if (imgs.length) {
      return {
        ok: true, id, kind: "images",
        title: d.desc || "",
        duration: 0,
        width: imgs[0].width, height: imgs[0].height,
        cover: imgs[0].url,
        images: imgs.map((x) => "/api/stream?u=" + encodeURIComponent(x.url)),
        // 每张默认停留 3 秒，前端据此自动翻页
        imageDuration: (d.images[0] && d.images[0].duration) || 3000,
        ...musicOf(d),
      };
    }
  }

  const v = d.video || {};
  // 优先 H.264（浏览器兼容性最好），依次降级
  const pick = v.play_addr_h264 || v.play_addr || v.play_addr_265;
  const list = (pick && pick.url_list) || [];
  if (!list.length) {
    return {
      ok: false, id, permanent: true,
      errMsg: "没有可用的播放地址（既不是图文，也没有视频流）",
    };
  }

  return {
    ok: true,
    id, kind: "video",
    title: d.desc || "",
    duration: v.duration || 0,          // ⭐ 毫秒，自动连播靠它
    width: pick.width || v.width || null,
    height: pick.height || v.height || null,
    cover: (v.cover && v.cover.url_list && v.cover.url_list[0]) || "",
    stream: "/api/stream?u=" + encodeURIComponent(list[0]),  // 直链有时效，不缓存
  };
}

/** 把 v.douyin.com 短链展开成真实地址，并抽出视频 ID */
async function expandShortLink(shortUrl) {
  let res;
  try {
    res = await fetch(shortUrl, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      redirect: "follow",
    });
  } catch (e) {
    return { ok: false, errMsg: `展开短链失败：${e.message}` };
  }
  const finalUrl = res.url;
  const id = extractIdFromUrl(finalUrl);
  if (!id) {
    return { ok: false, errMsg: `短链跳转到 ${finalUrl}，但没能从中提取出视频 ID` };
  }
  return { ok: true, id, finalUrl };
}

function extractIdFromUrl(u) {
  const patterns = [/\/video\/(\d{6,25})/, /modal_id=(\d{6,25})/, /\/share\/video\/(\d{6,25})/];
  for (const p of patterns) {
    const m = u.match(p);
    if (m) return m[1];
  }
  const m = u.match(ID_RE);
  return m ? m[0] : null;
}

// ------------------------------------------------------------------ 安装助手页
// 当浏览器不弹 Tampermonkey 安装页时的兜底：展示脚本全文 + 一键复制
function installPage(escapedJs, byteSize) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安装抖音采集器 · 手动路径</title>
<style>
  :root{--bg:#0b0b0d;--panel:#141418;--panel2:#1b1b21;--line:#2a2a33;--fg:#e8e8ee;
        --dim:#8b8b99;--accent:#fe2c55;--ok:#2ecc71;--warn:#f1c40f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:20px;margin:0 0 6px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:18px;margin-bottom:16px}
  .card.warn{background:#241f10;border-color:#5c4e1e}
  .card.ok{background:#10241a;border-color:#1e5c39}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 12px}
  ol{margin:0;padding-left:22px}
  ol li{margin-bottom:9px}
  code{background:var(--panel2);padding:2px 6px;border-radius:4px;font-size:12.5px;
       font-family:ui-monospace,Consolas,monospace}
  kbd{background:#23232b;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;
      padding:1px 6px;font-size:12px;font-family:ui-monospace,monospace}
  .step{display:flex;gap:12px;margin-bottom:16px}
  .num{flex:none;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;
       font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:2px}
  .step .body{flex:1}
  .step .body b{display:block;margin-bottom:3px}
  .hint{color:var(--dim);font-size:12.5px}
  .danger{color:var(--warn)}
  #src{width:100%;height:320px;margin-top:12px;background:#0e0e12;color:#c9c9d4;
       border:1px solid var(--line);border-radius:8px;padding:12px;
       font:11.5px/1.55 ui-monospace,Consolas,monospace;resize:vertical;white-space:pre}
  button{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--accent);
         border:0;border-radius:8px;padding:11px 22px;cursor:pointer}
  button:hover{background:#ff4569}
  button.done{background:var(--ok)}
  .bar{display:flex;align-items:center;gap:14px;margin-top:14px;flex-wrap:wrap}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  td{padding:7px 10px;border-bottom:1px solid #1f1f26;vertical-align:top}
  td:first-child{color:var(--warn);width:44%}
  tr:last-child td{border-bottom:0}
  a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">

  <h1>安装抖音采集器</h1>
  <div class="sub">浏览器没弹 Tampermonkey 安装页时走这条路 —— 手动粘贴，一定能成。</div>

  <div class="card warn">
    <h2>先排掉最常见的原因</h2>
    <div class="step">
      <div class="num">!</div>
      <div class="body">
        <b>「允许用户脚本」很可能没打开</b>
        <div class="hint">
          新版 Edge / Chrome 默认<b>禁止</b>扩展运行用户脚本。这个开关不打开，
          Tampermonkey 可能连安装拦截都不工作，而且<b class="danger">不会报任何错</b>。<br><br>
          地址栏输入 <code>edge://extensions</code> 回车 → 找到 <b>Tampermonkey</b> →
          点「<b>详细信息</b>」→ 打开「<b>允许用户脚本</b>」。
        </div>
      </div>
    </div>
  </div>

  <div class="card ok">
    <h2>手动安装（4 步）</h2>

    <div class="step">
      <div class="num">1</div>
      <div class="body">
        <b>打开 Tampermonkey 编辑器</b>
        <div class="hint">点浏览器右上角 <b>Tampermonkey 图标</b> → 选「<b>添加新脚本</b>」。<br>
        找不到图标就点扩展拼图按钮，把 Tampermonkey 固定到工具栏。</div>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="body">
        <b>清空编辑器里的模板</b>
        <div class="hint">在编辑器里按 <kbd>Ctrl</kbd>+<kbd>A</kbd> 全选 → <kbd>Delete</kbd> 删掉。
        里面那段示例代码必须删干净，否则会残留一个没用的脚本。</div>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="body">
        <b>复制下面的脚本全文，粘贴进编辑器</b>
        <div class="hint">点下面的大按钮复制，然后到编辑器里 <kbd>Ctrl</kbd>+<kbd>V</kbd>。</div>
      </div>
    </div>

    <div class="step">
      <div class="num">4</div>
      <div class="body">
        <b>保存</b>
        <div class="hint">按 <kbd>Ctrl</kbd>+<kbd>S</kbd>。Tampermonkey 标签页出现「已保存」即可。</div>
      </div>
    </div>

    <div class="bar">
      <button id="copy">复制脚本全文（${Math.round(byteSize / 1024)} KB）</button>
      <span class="hint" id="msg">也可以点进下面的文本框，<kbd>Ctrl</kbd>+<kbd>A</kbd> 再 <kbd>Ctrl</kbd>+<kbd>C</kbd> 手动复制。</span>
    </div>

    <textarea id="src" readonly spellcheck="false">${escapedJs}</textarea>
  </div>

  <div class="card">
    <h2>装好后怎么验证</h2>
    <ol>
      <li>打开 <a href="https://www.douyin.com/" target="_blank">https://www.douyin.com/</a></li>
      <li>看右上角 <b>Tampermonkey 图标</b>上有没有数字角标</li>
      <li>看<b>右下角</b>有没有一条黑色标题栏「抖音点赞采集器 · 大批量」</li>
    </ol>
    <div class="hint">两个都有 = 装好了。都没有 = 回上面检查「允许用户脚本」。</div>
  </div>

  <div class="card">
    <h2>仍然不弹安装页？对照排查</h2>
    <table>
      <tr><td>Tampermonkey 没装 / 被禁用</td>
          <td>去 <code>edge://extensions</code> 确认它存在且是<b>启用</b>状态</td></tr>
      <tr><td>「允许用户脚本」没打开</td>
          <td>上面第一条，最常见的坑</td></tr>
      <tr><td>浏览器把文件下载了</td>
          <td>看下载栏有没有一个 <code>.user.js</code> 文件。有的话说明 Tampermonkey 没在拦截，走手动路径</td></tr>
      <tr><td>页面直接显示了代码文本</td>
          <td>同上 —— 拦截没生效。这个页面的文本框就是为这种情况准备的</td></tr>
      <tr><td>装的是 Violentmonkey / 脚本猫等</td>
          <td>拦截机制不同，直接用它们各自的「新建脚本」功能，粘同一份代码即可</td></tr>
      <tr><td>公司电脑 / 受管设备</td>
          <td>组策略可能禁止了用户脚本，这种情况只能换台机器或走 Console 方式</td></tr>
    </table>
  </div>

</div>
<script>
(function () {
  var ta = document.getElementById("src");
  var btn = document.getElementById("copy");
  var msg = document.getElementById("msg");
  function done(ok) {
    if (ok) {
      btn.textContent = "✓ 已复制";
      btn.classList.add("done");
      msg.textContent = "到 Tampermonkey 编辑器里 Ctrl+V 粘贴，然后 Ctrl+S 保存。";
      setTimeout(function () {
        btn.textContent = "复制脚本全文";
        btn.classList.remove("done");
      }, 3000);
    } else {
      msg.textContent = "自动复制失败，请点进文本框 Ctrl+A 再 Ctrl+C。";
    }
  }
  btn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(function () { done(true); }, function () {
        ta.select(); var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        done(ok);
      });
    } else {
      ta.select(); var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      done(ok);
    }
  });
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ 服务
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (pathname === "/" || pathname === "/index.html") {
      const html = await readFile(path.join(__dirname, "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(html);
    }

    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }

    // 托管采集脚本：装了 Tampermonkey 的话，访问这个地址会直接弹出安装页；
    // 没装的话就是一个纯文本页面，方便复制粘贴。
    if (pathname === "/douyin-likes-collector.user.js") {
      const js = await readFile(
        path.join(__dirname, "..", "collector", "douyin-likes-collector.user.js")
      );
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(js);
    }

    // 手动安装助手页（不弹安装页时的兜底）
    if (pathname === "/install") {
      const js = await readFile(
        path.join(__dirname, "..", "collector", "douyin-likes-collector.user.js"),
        "utf8"
      );
      const escaped = js.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(installPage(escaped, Buffer.byteLength(js, "utf8")));
    }

    // 解析视频：直链 + 时长 + 封面
    if (pathname === "/api/play") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!id) return json(res, 400, { ok: false, errMsg: "缺少 id 参数" });
      const t0 = Date.now();
      const result = await resolvePlay(id);
      console.log(
        `[play] ${id} → ${result.ok ? "OK " + result.duration + "ms" : "FAIL " + result.errMsg}` +
        ` (${Date.now() - t0}ms)`
      );
      return json(res, 200, result);
    }

    // 视频流中转：CDN 有防盗链，只认 Referer: open.douyin.com，
    // 浏览器的 <video> 无法伪造 Referer，所以由服务端转发（支持 Range，可拖动进度）
    if (pathname === "/api/stream") {
      const target = url.searchParams.get("u");
      if (!target) return json(res, 400, { ok: false, errMsg: "缺少 u 参数" });

      let parsed;
      try { parsed = new URL(target); }
      catch { return json(res, 400, { ok: false, errMsg: "u 不是合法 URL" }); }

      if (!/^https?:$/.test(parsed.protocol) || !ALLOWED_CDN.test(parsed.hostname)) {
        return json(res, 403, { ok: false, errMsg: "不允许的域名：" + parsed.hostname });
      }

      const upstreamHeaders = {
        "user-agent": UA,
        "referer": "https://open.douyin.com/",
        "accept": "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
      };
      if (req.headers.range) upstreamHeaders.range = req.headers.range;

      let up;
      try {
        up = await fetch(target, { headers: upstreamHeaders });
      } catch (e) {
        return json(res, 502, { ok: false, errMsg: "上游请求失败：" + e.message });
      }

      if (up.status >= 400) {
        console.log(`[stream] 上游 ${up.status} —— 直链可能已过期或 Referer 被拒`);
      }

      const upType = up.headers.get("content-type") || "";
      // 视频/音频的直链是有时效的（约 3 小时），而且换源后内容会变 —— 一律不缓存。
      // 但**图片必须放行缓存**：抖音图片 CDN 返回的是 `max-age=31536000`（按 URL 不可变），
      // 之前这里一刀切成 no-store，导致浏览器每次换图都重新下载一遍，
      // 前端那个「头图预载」也就完全白做了（现象：图片与图片之间有一段空白）。
      // 只在成功响应上放行：403/404 那种错误响应绝不能缓存，否则会一直坏着。
      const isImage = /^image\//i.test(upType);
      const cacheable = isImage && up.status < 400;

      const outHeaders = {
        "content-type": upType || "video/mp4",
        "accept-ranges": up.headers.get("accept-ranges") || "bytes",
        "cache-control": cacheable
          ? (up.headers.get("cache-control") || "public, max-age=86400")
          : "no-store",
      };
      if (cacheable) {
        for (const h of ["etag", "last-modified"]) {
          const v = up.headers.get(h);
          if (v) outHeaders[h] = v;
        }
      }
      for (const h of ["content-length", "content-range"]) {
        const v = up.headers.get(h);
        if (v) outHeaders[h] = v;
      }

      res.writeHead(up.status, outHeaders);
      if (!up.body) return res.end();

      // 客户端断开时销毁上游，别白拉流量。
      // ⚠️ 不要对已被 pipe 占用的 Web ReadableStream 调 cancel()：
      //    那会返回一个被拒绝的 Promise（ERR_INVALID_STATE: ReadableStream is locked），
      //    try/catch 抓不到异步拒绝，未处理 rejection 会直接把 Node 进程干掉。
      const upstream = Readable.fromWeb(up.body);
      upstream.on("error", (e) => {
        console.error("[stream] 上游流错误:", e.message);
        try { res.destroy(); } catch (err) { /* ignore */ }
      });
      res.on("close", () => { try { upstream.destroy(); } catch (e) { /* ignore */ } });
      upstream.pipe(res);
      return;
    }

    // 展开短链
    if (pathname === "/api/expand") {
      const shortUrl = url.searchParams.get("url") || "";
      if (!/^https?:\/\/v\.douyin\.com\//i.test(shortUrl)) {
        return json(res, 400, { ok: false, errMsg: "只接受 v.douyin.com 开头的短链" });
      }
      const result = await expandShortLink(shortUrl);
      console.log(`[expand ] ${shortUrl} → ${result.ok ? result.id : "FAIL " + result.errMsg}`);
      return json(res, 200, result);
    }

    json(res, 404, { ok: false, errMsg: "not found" });
  } catch (e) {
    console.error("[error]", e);
    json(res, 500, { ok: false, errMsg: String(e && e.message) });
  }
});

// 兜底：本地服务是长跑的，不能因为一次未捕获异常就整个挂掉。
// 流代理、上游抖动这类地方最容易冒出来。
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

// ⚠️ 但上面的兜底会把"端口被占用"这种致命错误也吞掉：
//    进程不退出、也不在监听，变成一个看起来在跑其实是死的僵尸。
//    所以这里显式处理一下，给出能照着做的提示再退出。
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("");
    console.error("  端口 " + PORT + " 已被占用 —— 服务可能已经在运行了。");
    console.error("");
    console.error("  · 直接用正在跑的那个就行：http://" + HOST + ":" + PORT);
    console.error("  · 想换成新代码，先双击 stop.bat 停掉旧的，再重新启动");
    console.error("");
  } else {
    console.error("[server error]", e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ================================================");
  console.log("   随机播放点赞过的视频 · 本地服务已启动");
  console.log("  ================================================");
  console.log("");
  console.log("   地址：http://" + HOST + ":" + PORT);
  console.log("   浏览器应该已经自动打开了；没开就手动访问上面这个地址");
  console.log("");
  console.log("   · 关闭本窗口即可停止服务");
  console.log("   · 数据全部存在浏览器本地，服务端不落盘");
  console.log("");
  console.log("   直链接口 " + DETAIL_API);
  console.log("");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
