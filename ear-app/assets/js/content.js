/* 内容层：把「挂载的本地内容」与「导入的内容」合并成统一目录 */

import {
  listImportedEpisodes, getImportedEpisode, getMedia, isVerified,
} from './store.js';
import { cachedUrl } from './cache.js';

const url = (p) => new URL(p, location.href).href;

async function fetchJSON(p) {
  const res = await fetch(url(p), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
}

let catalog = null;
const linesCache = new Map();
const wordsCache = new Map();
const blobUrls = new Map();

/** 浏览器导入的内容没有 series，归到一个单独的合成合集里 */
const IMPORTED_SERIES = { id: 'imported', title: '导入的内容', subtitle: '', order: 99 };

/**
 * 读取目录（挂载 + 导入），按「合集顺序 → 合集内序号」排序。
 *
 * 目录 v2 起有 `series` 数组，每集带 `series` 字段，`order` 是**合集内**序号。
 * 旧版目录（没有 series）会被就地合成一个合集，保证渲染不会炸。
 */
export async function loadCatalog({ force = false } = {}) {
  if (catalog && !force) return catalog;

  let mounted = [];
  let error = null;
  let series = [];
  try {
    const m = await fetchJSON('content/episodes.json');
    mounted = (m.episodes || []).map((e) => ({ ...e, source: 'mounted' }));
    series = Array.isArray(m.series) ? m.series.slice() : [];
  } catch (e) {
    error = e;
  }

  let imported = [];
  try {
    imported = (await listImportedEpisodes())
      .map((e) => ({ ...e, source: 'imported', series: e.series || 'imported' }));
  } catch {}

  const all = [...mounted, ...imported];

  if (!series.length) {
    const seen = new Map();
    for (const e of all) {
      const id = e.series || 'default';
      if (!seen.has(id)) seen.set(id, seen.size + 1);
    }
    series = [...seen].map(([id, order]) => ({
      id, order, title: id === 'default' ? '动画' : id, subtitle: '',
    }));
  }
  if (imported.length && !series.some((s) => s.id === 'imported')) series.push(IMPORTED_SERIES);

  const meta = new Map(series.map((s, i) => [s.id, { ...s, order: s.order ?? i + 1 }]));
  const rank = (e) => meta.get(e.series || 'default')?.order ?? 99;

  const episodes = all
    .sort((a, b) => (rank(a) - rank(b))
      || ((a.order ?? 0) - (b.order ?? 0))
      || String(a.id).localeCompare(String(b.id)))
    .map((e) => ({
      ...e,
      seriesMeta: meta.get(e.series || 'default') || null,
      subtitleStatus: isVerified(e.id) ? 'verified' : (e.subtitleStatus || (e.lineCount ? 'draft' : 'missing')),
    }));

  catalog = {
    episodes,
    series: [...meta.values()].sort((a, b) => a.order - b.order),
    error, mountedCount: mounted.length, importedCount: imported.length,
  };
  return catalog;
}

/** 按合集切分（保持合集顺序、合集内保持目录顺序），供选集页分节渲染 */
export function groupBySeries(catalog) {
  const groups = [];
  for (const s of catalog.series || []) {
    const list = catalog.episodes.filter((e) => (e.series || 'default') === s.id);
    if (list.length) groups.push({ series: s, episodes: list });
  }
  // 兜底：series 里没提到、但实际存在的分组
  const covered = new Set(groups.flatMap((g) => g.episodes.map((e) => e.id)));
  const rest = catalog.episodes.filter((e) => !covered.has(e.id));
  if (rest.length) groups.push({ series: { id: '_rest', title: '其它', order: 999 }, episodes: rest });
  return groups;
}

export function getCachedEpisode(id) {
  return catalog ? catalog.episodes.find((e) => e.id === id) || null : null;
}

/** 逐句字幕（挂载内容按需拉取，导入内容内联在记录里） */
export async function loadLines(ep) {
  if (!ep) return [];
  if (linesCache.has(ep.id)) return linesCache.get(ep.id);

  let lines = [];
  if (Array.isArray(ep.lines) && ep.lines.length) {
    lines = ep.lines;
  } else if (ep.source === 'mounted') {
    try {
      const doc = await fetchJSON(`content/subs/${ep.id}.json`);
      lines = doc.lines || [];
    } catch {
      lines = [];
    }
  } else {
    const rec = await getImportedEpisode(ep.id);
    lines = (rec && rec.lines) || [];
  }
  lines = lines.slice().sort((a, b) => a.start - b.start);
  linesCache.set(ep.id, lines);
  return lines;
}

export function invalidateLines(id) { linesCache.delete(id); }
export function invalidateCatalog() { catalog = null; }

/**
 * 每集的闪卡单词（≤10 个）。挂载内容读 content/words/<id>.json，
 * 导入内容允许把 words 内联在记录里。词都取自该集自己的台词，
 * `line` 指向例句所在行，可用于「听这句」跳转。
 */
export async function loadWords(ep) {
  if (!ep) return [];
  if (wordsCache.has(ep.id)) return wordsCache.get(ep.id);

  let words = [];
  if (Array.isArray(ep.words) && ep.words.length) {
    words = ep.words;
  } else if (ep.source === 'imported') {
    try {
      const rec = await getImportedEpisode(ep.id);
      words = (rec && rec.words) || [];
    } catch { words = []; }
  } else {
    try {
      const doc = await fetchJSON(`content/words/${ep.id}.json`);
      words = doc.words || [];
    } catch { words = []; }
  }
  words = words.filter((w) => w && w.en);
  wordsCache.set(ep.id, words);
  return words;
}

export function invalidateWords(id) { wordsCache.delete(id); }

/**
 * 解析视频地址：导入内容用 Blob URL，挂载内容用相对路径。
 *
 * 挂载内容若已缓存到本机，**本机 blob 排第一**，网络地址留在后面兜底 ——
 * video 的 error 处理器会自动顺位切到下一个源，所以缓存被浏览器回收也不会白屏。
 */
export async function videoSources(ep) {
  if (!ep) return [];
  if (ep.source === 'imported') {
    if (!blobUrls.has(ep.id)) {
      const blob = await getMedia(ep.id);
      if (blob) blobUrls.set(ep.id, URL.createObjectURL(blob));
    }
    const u = blobUrls.get(ep.id);
    return u ? [u] : [];
  }
  const list = [];
  if (blobUrls.has(ep.id)) {
    list.push(blobUrls.get(ep.id));
  } else {
    const local = await cachedUrl(ep.id).catch(() => null);
    if (local) {
      blobUrls.set(ep.id, local);
      list.push(local);
    }
  }
  if (ep.video) list.push(url(ep.video));
  if (ep.videoFallback) list.push(url(ep.videoFallback));
  return list;
}

export function thumbUrl(ep) {
  if (!ep) return null;
  if (ep.thumbnailDataUrl) return ep.thumbnailDataUrl;
  if (ep.thumbnail) return url(ep.thumbnail);
  return null;
}

export function releaseBlobUrls() {
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
}
