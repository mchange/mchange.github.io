/* 内容层：把「挂载的本地内容」与「导入的内容」合并成统一目录 */

import {
  listImportedEpisodes, getImportedEpisode, getMedia, isVerified,
} from './store.js';

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

/** 读取目录（挂载 + 导入），按 order 排序 */
export async function loadCatalog({ force = false } = {}) {
  if (catalog && !force) return catalog;

  let mounted = [];
  let error = null;
  try {
    const m = await fetchJSON('content/episodes.json');
    mounted = (m.episodes || []).map((e) => ({ ...e, source: 'mounted' }));
  } catch (e) {
    error = e;
  }

  let imported = [];
  try {
    imported = (await listImportedEpisodes()).map((e) => ({ ...e, source: 'imported' }));
  } catch {}

  const episodes = [...mounted, ...imported]
    .sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)))
    .map((e) => ({
      ...e,
      subtitleStatus: isVerified(e.id) ? 'verified' : (e.subtitleStatus || (e.lineCount ? 'draft' : 'missing')),
    }));

  catalog = { episodes, error, mountedCount: mounted.length, importedCount: imported.length };
  return catalog;
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

/** 解析视频地址：导入内容用 Blob URL，挂载内容用相对路径 */
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
