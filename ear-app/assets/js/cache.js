/* 视频本机缓存：策略层（存哪里由 store.js 的 vcache/vmeta 负责，这里管「该不该存」）
 *
 * 为什么需要：
 *   iPad 走局域网看视频，每次跳转（点字幕、拖进度条、单句循环）浏览器都要重新发
 *   Range 请求。wifi 一抖就是几百毫秒的卡顿，孩子按了「听这句」却半天不动。
 *   整集存到本机后，跳转变成纯本地读取，基本瞬时。
 *
 * 三个职责：
 *   1. 播放时后台把整集存下来（不打断当前播放）；
 *   2. 进选集页时按预算 + LRU 淘汰，释放空间；
 *   3. 顺带清掉已经不存在的集的「孤儿缓存」。
 */

import {
  cacheHas, cacheGetBlob, cachePut, cacheMetaAll, cacheDelete, cacheClear,
  cacheTouch, persistStorage,
} from './store.js';

/* 单集超过这个大小就不缓存了 —— 本机 12 集约 64MB/集，给大文件留个闸门，
   免得一碗把 iPad 的存储配额吃穿（Safari 单站点配额有限，还要弹权限）。 */
const MAX_ITEM_BYTES = 260 * 1024 * 1024;

/* 正在下载的集，避免重复请求（快速来回切集时很容易撞上） */
const inflight = new Map();

export function fmtMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export async function isCached(id) {
  return cacheHas(id);
}

/** 命中就返回 blob URL，并把「最近使用」时间刷新（LRU 排序用） */
export async function cachedUrl(id) {
  const blob = await cacheGetBlob(id);
  if (!blob) return null;
  cacheTouch(id);
  return URL.createObjectURL(blob);
}

export async function stats() {
  const items = await cacheMetaAll();
  const bytes = items.reduce((s, r) => s + (r.size || 0), 0);
  return { items, count: items.length, bytes };
}

/**
 * 把整集视频下载到本机。onProgress(0..1, loadedBytes, totalBytes)。
 * 已有缓存直接返回；正在下载则复用同一个 Promise。
 */
export function cacheEpisode(id, url, { onProgress, title, durationSeconds } = {}) {
  if (inflight.has(id)) return inflight.get(id);

  const job = (async () => {
    if (await cacheHas(id)) return { ok: true, skipped: true };

    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total = Number(res.headers.get('Content-Length')) || 0;
    if (total && total > MAX_ITEM_BYTES) {
      return { ok: false, reason: 'too-big', bytes: total };
    }

    const chunks = [];
    let loaded = 0;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (onProgress) onProgress(total ? loaded / total : 0, loaded, total);
      }
    } else {
      const buf = await res.arrayBuffer();
      chunks.push(new Uint8Array(buf));
      loaded = buf.byteLength;
      if (onProgress) onProgress(1, loaded, loaded);
    }

    if (!loaded) throw new Error('空响应');
    const blob = new Blob(chunks, { type: 'video/mp4' });
    chunks.length = 0;

    await persistStorage();             // 尽量申请「持久化」，别被浏览器当成临时缓存清掉
    await cachePut(id, blob, { title, durationSeconds });
    return { ok: true, bytes: blob.size };
  })();

  job.catch(() => {}).finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/**
 * 按预算淘汰。
 *   budgetMB = 0 表示不限（只清孤儿）。
 *   淘汰顺序：先孤儿 → 再按「最近使用」从旧到新删，直到低于预算。
 */
export async function enforceBudget(budgetMB, validIds = null) {
  const items = await cacheMetaAll();          // 已按最近使用倒序

  let removed = 0;
  let bytes = 0;

  // 1) 孤儿：缓存还在，但目录里已经没有这一集了
  const keep = [];
  for (const r of items) {
    if (validIds && !validIds.has(r.id)) {
      await cacheDelete(r.id);
      removed += 1;
      continue;
    }
    keep.push(r);
    bytes += r.size || 0;
  }

  // 2) 超预算：从最久没用的开始删
  const budget = budgetMB > 0 ? budgetMB * 1024 * 1024 : Infinity;
  for (let i = keep.length - 1; i >= 0 && bytes > budget; i -= 1) {
    await cacheDelete(keep[i].id);
    bytes -= keep[i].size || 0;
    removed += 1;
  }

  return { removed, bytes };
}

export async function clearAll() {
  await cacheClear();
}
