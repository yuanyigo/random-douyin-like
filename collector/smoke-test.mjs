// 采集器冒烟测试：用最小 DOM 桩在 Node 里跑一遍。
// 覆盖：脚本加载、网络钩子、递归提取、非法 ID 过滤、断点续采（localStorage 载入）。
// 跑法：node smoke-test.mjs

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./douyin-likes-collector.user.js", import.meta.url), "utf8");
const LS_KEY = "tlk_collector_v2";

// ---------------------------------------------------------------- DOM 桩
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attrs = {};
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 800;
    this._html = "";
    this.classList = {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); },
    };
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); }
  querySelector() { return new El("div"); }
  querySelectorAll() { return []; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = v; }
  addEventListener() {}
  remove() {}
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
}

const documentStub = {
  readyState: "complete",
  hidden: false,
  documentElement: new El("html"),
  head: new El("head"),
  body: new El("body"),
  createElement: (t) => new El(t),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};

// ---------------------------------------------------------------- 其它全局桩
const store = new Map();

globalThis.document = documentStub;
globalThis.location = {
  href: "https://www.douyin.com/user/self?showTab=like",
  pathname: "/user/self",
};
// SPA 路由钩子需要 history
globalThis.history = {
  pushState() {},
  replaceState() {},
};
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true, writable: true,
});
globalThis.getComputedStyle = () => ({ overflowY: "visible" });
globalThis.Blob = class {};
globalThis.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
globalThis.confirm = () => true;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ---------------------------------------------------------------- 预置「上次采集结果」，验证断点续采
const RESUMED_IDS = ["7578091056131901007", "7661144633817502897"];
store.set(LS_KEY, JSON.stringify({
  v: 2, ids: RESUMED_IDS.join("\n"), count: 2, rounds: 42, savedAt: Date.now(), reason: "auto",
}));

// ---------------------------------------------------------------- 页面原始 fetch
const FIXTURE = {
  status_code: 0,
  aweme_list: [
    { aweme_id: "7653835574377576410", desc: "顶层数组" },
    { desc: "嵌套在深层", statistics: { inner: { aweme_id: "7300000000000000000" } } },
    { aweme_id: "not-a-valid-id" },
    { aweme_id: "12345" },
  ],
};

const windowStub = {
  fetch: async () => ({ clone: () => ({ json: async () => FIXTURE }) }),
  XMLHttpRequest: class { open() {} send() {} addEventListener() {} },
  addEventListener: () => {},
  scrollBy: () => {}, scrollTo: () => {}, scrollY: 0, innerHeight: 800,
};
const origFetch = windowStub.fetch;
globalThis.window = windowStub;

// ---------------------------------------------------------------- 加载
let loadError = null;
try { new Function(SRC)(); } catch (e) { loadError = e; }

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

check("脚本加载无异常", !loadError, loadError ? loadError.message : "");
if (loadError) process.exit(1);

const api = windowStub.__TLK_COLLECTOR__;
check("__TLK_COLLECTOR__ 已挂载", !!api);
check("window.fetch 已被包装", windowStub.fetch !== origFetch);
check("断点续采：载入了上次的 2 个", api.size === 2, "实际 " + api.size);
check("续采的 ID 内容正确", RESUMED_IDS.every((id) => api.ids.has(id)));

// ---------------------------------------------------------------- 触发钩子
const before = api.size;
await windowStub.fetch("https://www.douyin.com/aweme/v1/web/aweme/favorite/?count=20&max_cursor=0", {});
await new Promise((r) => setTimeout(r, 80));
const got = [...api.ids];

check("网络钩子采到新数据", api.size > before, before + " → " + api.size);
check("两层嵌套 aweme_id 也能捞出", got.includes("7300000000000000000"));
check("顶层 aweme_id 捞出", got.includes("7653835574377576410"));
check("非法 ID 被过滤", !got.includes("not-a-valid-id") && !got.includes("12345"));
check("总数正确（2 续采 + 2 新增 = 4）", api.size === 4, "实际 " + api.size);

// ---------------------------------------------------------------- 非 aweme 接口
const before2 = api.size;
await windowStub.fetch("https://www.douyin.com/other/api", {});
await new Promise((r) => setTimeout(r, 50));
check("非 /aweme/ 接口不触发采集", api.size === before2, before2 + " → " + api.size);

// ---------------------------------------------------------------- 导出
const txt = api.text();
check("导出为每行一个 ID", txt.split("\n").length === api.size);
check("导出内容均为合法 ID", txt.split("\n").every((l) => /^\d{15,25}$/.test(l)));

// ---------------------------------------------------------------- 从备份恢复
// localStorage 会被换浏览器/清站点数据抹掉，下载的 TXT/JSON 是唯一备份，
// 所以这条路径必须能独立工作。
check("parseIdsFromText 解析纯 TXT", api.parseIdsFromText(txt).length === api.size);

const jsonBackup = JSON.stringify({
  source: "douyin-likes", count: 2,
  ids: ["7373164975042481460", "7085560604785757470"],
});
const parsedJson = api.parseIdsFromText(jsonBackup);
check("parseIdsFromText 解析 JSON 的 ids 数组", parsedJson.length === 2 &&
  parsedJson[0] === "7373164975042481460", JSON.stringify(parsedJson));

check("parseIdsFromText 过滤非法 ID",
  api.parseIdsFromText("12345\nnot-an-id\n7653835574377576410").length === 1);
check("parseIdsFromText 对乱内容不抛异常",
  api.parseIdsFromText("") .length === 0 && api.parseIdsFromText("{}").length === 0);

const beforeRestore = api.size;
const r1 = api.restoreFromText(jsonBackup, "backup.json");
check("restoreFromText 新增了 2 个", r1.added === 2 && api.size === beforeRestore + 2,
  JSON.stringify(r1));
check("恢复的 ID 真的进了集合", api.ids.has("7373164975042481460"));

const r2 = api.restoreFromText(jsonBackup, "backup.json");
check("重复恢复不产生新增（幂等）", r2.added === 0 && api.size === beforeRestore + 2,
  JSON.stringify(r2));

const savedState = JSON.parse(store.get(LS_KEY));
check("恢复后已写回 localStorage", savedState.count === api.size &&
  savedState.ids.split("\n").length === api.size, "count=" + savedState.count);

// 真实那份导出文件：路径是机器相关的，所以从命令行参数取，取不到就跳过。
//   node smoke-test.mjs "C:\Users\me\Downloads\douyin-likes-2026-09-19 (4).txt"
const realPath = process.argv[2] || process.env.TLK_EXPORT;
if (realPath) {
  const real = api.parseIdsFromText(readFileSync(realPath, "utf8"));
  check("真实导出文件全部解析为合法唯一 ID",
    real.length > 0 && new Set(real).size === real.length,
    real.length + " 个 / " + new Set(real).size + " 唯一");
} else {
  check("真实导出文件校验（没传路径，跳过）", true, "node smoke-test.mjs <导出.txt>");
}

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.pass);
console.log("\n" + "=".repeat(52));
console.log(`通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
