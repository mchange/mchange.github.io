/* =========================================================================
 * 学生端 Service Worker(需求 #25:唯一"稍微高级"的东西,保持小巧)
 *
 * 职责:
 *   1. 预缓存页面外壳(index.html,内联 CSS/JS)→ 离线也能打开页面
 *   2. 音频 / 计划 JSON:网络优先并写入运行时缓存,断网时回退到任意缓存副本
 *      (当天 MP3 主要由页面通过 Cache Storage 预载到 dictation-<date>,
 *       这里作为第二层兜底)
 *   3. 激活时清理:保留最近 7 天的 dictation-<date> 缓存
 * ========================================================================= */

"use strict";

const SHELL_CACHE = "dictation-shell-v1";
const RUNTIME_CACHE = "dictation-runtime-v1";
const SHELL_ASSETS = ["./", "./index.html"];
const KEEP_DATE_CACHES = 7;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      // 按日期排序所有 dictation-YYYY-MM-DD 缓存
      const dateCaches = keys
        .filter((k) => /^dictation-\d{4}-\d{2}-\d{2}$/.test(k))
        .sort(); // 日期字符串排序即时间排序
      const toDelete = dateCaches.slice(0, Math.max(0, dateCaches.length - KEEP_DATE_CACHES));

      await Promise.all(
        keys
          .filter(
            (k) =>
              (toDelete.includes(k)) ||
              ((k.startsWith("dictation-shell-") || k.startsWith("dictation-runtime-")) &&
                k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          )
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域不管

  const path = url.pathname;
  const isAudio = path.includes("/audio/");
  const isData = path.includes("/data/") || path.endsWith(".json");

  // 1) 页面导航:网络优先,断网回退到缓存的 index.html
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put("./index.html", clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match("./index.html").then((hit) => hit || caches.match("./"))
        )
    );
    return;
  }

  // 2) 计划 JSON:网络优先(家长当天可能重新生成),断网回退缓存副本
  if (isData) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match(req).then(
            (hit) => hit || new Response("offline", { status: 504, statusText: "Offline" })
          )
        )
    );
    return;
  }

  // 3) 音频:先查所有缓存(含页面预载的 dictation-<date>),
  //    未命中再走网络并写入运行时缓存;断网且无缓存时返回 504
  if (isAudio) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((resp) => {
            if (resp && resp.ok) {
              const clone = resp.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
            }
            return resp;
          })
          .catch(() => new Response("offline", { status: 504, statusText: "Offline" }));
      })
    );
    return;
  }

  // 4) 其余同源静态资源(如 sw.js):缓存优先
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
    )
  );
});
