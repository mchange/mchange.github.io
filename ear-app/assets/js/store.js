/* 数据层：偏好、播放进度、校对状态（localStorage）+ 导入内容（IndexedDB）
 *
 * 说明（对应方案 §6）：
 *   - 挂载内容（downloads/ 下的本地文件）不进浏览器存储，只记清单 + 进度 + 偏好；
 *   - 通过「内容整理」导入的新集数，视频 Blob 写入 IndexedDB（方案 A，已实测可用）。
 */

const NS = 'moerduo.v1';
const KEY = {
  prefs:    `${NS}.prefs`,
  progress: `${NS}.progress`,
  verified: `${NS}.verified`,
  last:     `${NS}.lastEpisode`,
  importedVerified: `${NS}.imported`,
  passes:   `${NS}.passes`,
  cards:    `${NS}.cards`,
};

export const DEFAULT_PREFS = {
  mode: 'continuous',       // continuous | single | shadow（跟读）
  rate: 1.0,
  showChineseHint: true,
  blindFirst: false,        // 盲听：先遮住英文字幕，点某句才揭示
  gapSeconds: 3,            // 跟读模式下每句后的留白秒数
  subtitleMode: 'both',     // 播放器内字幕：both 中英 | zh 中 | en 英 | off 关
};
export const RATES = [0.75, 0.9, 1.0, 1.25];
export const MODES = ['continuous', 'single', 'shadow'];
export const GAP_CHOICES = [2, 3, 5];
export const SUBTITLE_MODES = ['off', 'zh', 'en', 'both'];
export const SUBTITLE_LABELS = { off: '关', zh: '中', en: '英', both: '中英' };

/* ---------------------------------------------------------------- localStorage */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch { return false; }
}

export function storageAvailable() {
  try {
    const k = `${NS}.probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

/* 偏好（方案 §6.3） */
export function getPrefs() {
  return { ...DEFAULT_PREFS, ...readJSON(KEY.prefs, {}) };
}
export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  if (!RATES.includes(next.rate)) next.rate = 1.0;
  if (!MODES.includes(next.mode)) next.mode = 'continuous';
  if (!GAP_CHOICES.includes(next.gapSeconds)) next.gapSeconds = 3;
  if (!SUBTITLE_MODES.includes(next.subtitleMode)) next.subtitleMode = 'both';
  writeJSON(KEY.prefs, next);
  return next;
}

/* 播放进度（方案 §6.3） */
export function allProgress() { return readJSON(KEY.progress, {}); }
export function getProgress(episodeId) { return allProgress()[episodeId] || null; }
export function saveProgress(episodeId, positionSeconds, lastLineIndex) {
  const all = allProgress();
  all[episodeId] = {
    episodeId,
    lastPositionSeconds: Math.max(0, Math.round(positionSeconds * 10) / 10),
    lastLineIndex: Number.isInteger(lastLineIndex) ? lastLineIndex : null,
    updatedAt: new Date().toISOString(),
  };
  writeJSON(KEY.progress, all);
  writeJSON(KEY.last, episodeId);
}
export function clearProgress(episodeId) {
  const all = allProgress();
  delete all[episodeId];
  writeJSON(KEY.progress, all);
}
export function lastEpisodeId() { return readJSON(KEY.last, null); }

/* 校对状态：方案要求「待整理 / 已校对」有清晰区分 */
export function verifiedMap() { return readJSON(KEY.verified, {}); }
export function isVerified(id) { return !!verifiedMap()[id]; }
export function setVerified(id, on) {
  const m = verifiedMap();
  if (on) m[id] = new Date().toISOString(); else delete m[id];
  writeJSON(KEY.verified, m);
  return m;
}
export function verifiedCount() { return Object.keys(verifiedMap()).length; }

/* 收听遍数：磨耳朵的关键是「同一集反复听」，让家长看得见进度 */
export function passesMap() { return readJSON(KEY.passes, {}); }
export function getPasses(episodeId) {
  const n = passesMap()[episodeId];
  return Number.isFinite(n) ? n : 0;
}
export function bumpPass(episodeId) {
  const m = passesMap();
  m[episodeId] = (Number.isFinite(m[episodeId]) ? m[episodeId] : 0) + 1;
  writeJSON(KEY.passes, m);
  return m[episodeId];
}
export function resetPasses(episodeId) {
  const m = passesMap();
  delete m[episodeId];
  writeJSON(KEY.passes, m);
}

/* 闪卡「我会了」标记：按集 × 单词记，家长能看见认词进度 */
export function cardsMap() { return readJSON(KEY.cards, {}); }
export function knownWords(episodeId) {
  const m = cardsMap()[episodeId];
  return (m && typeof m === 'object') ? m : {};
}
export function isCardKnown(episodeId, word) { return !!knownWords(episodeId)[word]; }
export function setCardKnown(episodeId, word, known) {
  const all = cardsMap();
  const m = (typeof all[episodeId] === 'object' && all[episodeId]) || {};
  if (known) m[word] = new Date().toISOString(); else delete m[word];
  all[episodeId] = m;
  writeJSON(KEY.cards, all);
  return m;
}
export function resetCards(episodeId) {
  const all = cardsMap();
  delete all[episodeId];
  writeJSON(KEY.cards, all);
}

/* ---------------------------------------------------------------- IndexedDB */

const DB_NAME = 'moerduo';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('此浏览器不支持 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('episodes')) db.createObjectStore('episodes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}
function toPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listImportedEpisodes() {
  try {
    const store = await tx('episodes', 'readonly');
    const rows = await toPromise(store.getAll());
    return (rows || []).sort((a, b) => a.order - b.order);
  } catch { return []; }
}
export async function getImportedEpisode(id) {
  try {
    const store = await tx('episodes', 'readonly');
    return await toPromise(store.get(id)) || null;
  } catch { return null; }
}
export async function getMedia(id) {
  try {
    const store = await tx('media', 'readonly');
    const rec = await toPromise(store.get(id));
    return rec ? rec.blob : null;
  } catch { return null; }
}
export async function putImportedEpisode(record, videoBlob) {
  const es = await tx('episodes', 'readwrite');
  await toPromise(es.put(record));
  if (videoBlob) {
    const ms = await tx('media', 'readwrite');
    await toPromise(ms.put({ id: record.id, blob: videoBlob }));
  }
  return record;
}
export async function deleteImportedEpisode(id) {
  const es = await tx('episodes', 'readwrite');
  await toPromise(es.delete(id));
  const ms = await tx('media', 'readwrite');
  await toPromise(ms.delete(id));
}

/** 估算配额（方案 §5.2 要求显示存储状态） */
export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch {}
  return null;
}

export async function persistStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
