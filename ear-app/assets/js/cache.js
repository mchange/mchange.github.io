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
  cacheHas, cacheGetBlob, cachePut, cacheMetaAll, cacheMeta, cacheDelete,
  cacheClear, cacheClearAuto, cacheTouch, persistStorage,
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
  const manual = items.filter((r) => r.origin === 'manual');
  const manualBytes = manual.reduce((s, r) => s + (r.size || 0), 0);
  return {
    items, count: items.length, bytes,
    manualCount: manual.length, manualBytes,
    autoBytes: bytes - manualBytes,
  };
}

/* ---------------------------------------------------------------- 手动本机视频
 *
 * 用途：家长把 mp4 存进 iPad 的「文件」App，在「内容整理」里选一次，网页把视频
 * 写进本机缓存。之后播放直接命中 blob（videoSources 已把本机排第一、网络排第二），
 * 没配的集照常走网络。iPad 网页读不到「文件」App 的任意路径，只能由用户选一次，
 * 但选完就常驻 IndexedDB —— 刷新、断网都还在。
 */

/** 把用户选中的本地文件写成这一集的本机视频（origin=manual，豁免 LRU 淘汰） */
export async function putLocalVideo(id, file, meta = {}) {
  const blob = new Blob([file], { type: file.type || 'video/mp4' });
  await persistStorage();
  try {
    await cachePut(id, blob, {
      ...meta, origin: 'manual', fileName: file.name || '',
    });
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError'
      || /quota|storage full|空间/i.test(String(err.message || '')));
    if (quota) {
      throw new Error('这台设备的浏览器存储空间不够了。请先移除几集本机视频，或只配置常看的几集。');
    }
    throw new Error(`写入失败：${err && err.message ? err.message : err}`);
  }
  return blob.size;
}

/** 移除手动配置：这一集回到「从网络加载」 */
export async function removeLocalVideo(id) {
  return cacheDelete(id);
}

/** id → 元数据，只含手动配置的集；内容整理页用来渲染状态 */
export async function localVideoMap() {
  const items = await cacheMetaAll();
  return new Map(items.filter((r) => r.origin === 'manual').map((r) => [r.id, r]));
}

export async function localVideoMeta(id) {
  return cacheMeta(id);
}

/** 只清自动缓存，手动配置的本机视频保留 */
export async function clearAuto() {
  return cacheClearAuto();
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
  let manualBytes = 0;
  let manualCount = 0;
  let autoBytes = 0;
  const evictable = [];                       // 只有自动缓存可以被淘汰

  // 1) 孤儿：缓存还在，但目录里已经没有这一集了（含手动配置的孤儿，一并清掉）
  for (const r of items) {
    if (validIds && !validIds.has(r.id)) {
      await cacheDelete(r.id);
      removed += 1;
      continue;
    }
    if (r.origin === 'manual') {
      manualBytes += r.size || 0;
      manualCount += 1;
      continue;                               // 家长手动放的不动
    }
    autoBytes += r.size || 0;
    evictable.push(r);
  }

  // 2) 超预算：预算只约束「自动缓存」，从最久没用的开始删
  const budget = budgetMB > 0 ? budgetMB * 1024 * 1024 : Infinity;
  for (let i = evictable.length - 1; i >= 0 && autoBytes > budget; i -= 1) {
    await cacheDelete(evictable[i].id);
    autoBytes -= evictable[i].size || 0;
    removed += 1;
  }

  return {
    removed, bytes: autoBytes + manualBytes,
    autoBytes, manualBytes, manualCount,
  };
}

export async function clearAll() {
  await cacheClear();
}
