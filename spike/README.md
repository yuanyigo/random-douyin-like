# spike · 播放原型

这里是播放端原型（`server.mjs` + `index.html`）。

**当前的设计与结论请看根目录的 [NOTES.md](../NOTES.md)，本文件只是这个原型最早一版的历史记录。**

最早一版走的是抖音开放平台的**官方嵌入式播放器**：

```
取 iframe：  https://open.douyin.com/api/douyin/v1/video/get_iframe_by_video?video_id={id}
播放器地址：  https://open.douyin.com/player/video?vid={id}&autoplay=0
```

当时验证出的四条（后来都并进了 NOTES.md）：

| 验证项 | 结果 |
|---|---|
| 是否需要鉴权 / access_token | **不需要**，直接返回 `err_no: 0` |
| 能否播非本人账号的视频 | **能** |
| 是否允许被 iframe 嵌套 | **允许**，无 XFO、无 CSP `frame-ancestors` |
| 无效 ID 的行为 | `err_no: 28003004`「非公开视频」 |

当时也得出一条方法论教训：`www.douyin.com` **不能**被 iframe 嵌套，但用脚本裸调探测会得到
「允许嵌套」的**假象** —— WAF 给非浏览器请求返回的是不含 XFO 的反爬壳页面。
**只有真实浏览器能作为判据。**

后来放弃这条路，是因为官方播放器**写死 `autoplay=0`**，而且不返回视频时长，
做不了自动连播。现在改成 `aweme/detail` 取直链 + 原生 `<video>`，详见 NOTES.md。

## 运行

```powershell
cd spike
node server.mjs
```

零依赖，Node 18+。然后打开 <http://127.0.0.1:5178>。
