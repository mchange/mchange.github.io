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
  sideTab: 'subs',          // 右侧面板当前页签：subs 字幕表 | cards 闪卡
  endMode: 'loop',          // 一集播完怎么办：loop 循环本集 | across 连播下一集 | stop 播完即停
  autoHideChrome: false,    // 播放时是否自动收起进度条/控制条（默认不收，孩子自己找得到按钮）
  keepAwake: true,          // 播放期间申请屏幕常亮，别让 iPad 自己锁屏（单句/跟读会频繁暂停）
  videoCache: 'auto',       // 视频本机缓存：auto 打开一集就后台存到本机 | off 只用网络
  cacheBudgetMB: 260,       // 本机缓存上限（MB），超了按「最久没用」淘汰；0 = 不限
};
export const RATES = [0.5, 0.75, 0.9, 1.0, 1.25];
export const MODES = ['continuous', 'single', 'shadow'];
export const GAP_CHOICES = [2, 3, 5];
export const CACHE_CHOICES = [130, 260, 520, 0];   // MB；0 = 不限（按设备剩余空间自便）
export const END_MODES = ['loop', 'across', 'stop'];
export const SUBTITLE_MODES = ['off', 'zh', 'en', 'both'];
export const SUBTITLE_LABELS = { off: '关', zh: '中', en: '英', both: '中英' };
export const SIDE_TABS = ['subs', 'cards'];

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
  if (!SIDE_TABS.includes(next.sideTab)) next.sideTab = 'subs';
  if (!END_MODES.includes(next.endMode)) next.endMode = 'loop';
  next.autoHideChrome = !!next.autoHideChrome;
  next.keepAwake = next.keepAwake !== false;
  if (!['auto', 'off'].includes(next.videoCache)) next.videoCache = 'auto';
  if (!CACHE_CHOICES.includes(next.cacheBudgetMB)) next.cacheBudgetMB = 260;
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
const DB_VERSION = 2;
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
      // 视频本机缓存：blob 与元数据分两个 store —— 列清单时只想读元数据，
      // 若和 blob 混在一起，getAll() 会把每个视频整份读进内存。
      if (!db.objectStoreNames.contains('vcache')) db.createObjectStore('vcache', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('vmeta')) db.createObjectStore('vmeta', { keyPath: 'id' });
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

/* ------------------------------------------------ 视频本机缓存（vcache / vmeta）
 *
 * 为什么存在：iPad 走局域网看视频时，每次跳转（点字幕、拖进度、单句循环）都要
 * 重新发 Range 请求，wifi 抖动就是几百毫秒的卡顿。整集存到本机后，跳转是纯本地
 * 读取。存 blob 不存 base64，避免 33% 膨胀与一次性大字符串。
 */

export async function cacheHas(id) {
  try {
    const s = await tx('vmeta', 'readonly');
    return !!(await toPromise(s.getKey(id)));
  } catch { return false; }
}

export async function cacheGetBlob(id) {
  try {
    const s = await tx('vcache', 'readonly');
    const rec = await toPromise(s.get(id));
    return rec ? rec.blob : null;
  } catch { return null; }
}

export async function cachePut(id, blob, meta = {}) {
  const vs = await tx('vcache', 'readwrite');
  await toPromise(vs.put({ id, blob }));
  const ms = await tx('vmeta', 'readwrite');
  const now = Date.now();
  await toPromise(ms.put({
    id, size: blob.size, savedAt: now, usedAt: now,
    title: meta.title || '', durationSeconds: meta.durationSeconds || 0,
  }));
  return blob.size;
}

/** 全部缓存的元数据（不含 blob，很轻），按「最近使用」倒序 */
export async function cacheMetaAll() {
  try {
    const s = await tx('vmeta', 'readonly');
    const rows = await toPromise(s.getAll());
    return (rows || []).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  } catch { return []; }
}

export async function cacheTouch(id) {
  try {
    const s = await tx('vmeta', 'readwrite');
    const rec = await toPromise(s.get(id));
    if (!rec) return;
    rec.usedAt = Date.now();
    await toPromise(s.put(rec));
  } catch {}
}

export async function cacheDelete(id) {
  try {
    const vs = await tx('vcache', 'readwrite');
    await toPromise(vs.delete(id));
    const ms = await tx('vmeta', 'readwrite');
    await toPromise(ms.delete(id));
    return true;
  } catch { return false; }
}

export async function cacheClear() {
  try {
    const vs = await tx('vcache', 'readwrite');
    await toPromise(vs.clear());
    const ms = await tx('vmeta', 'readwrite');
    await toPromise(ms.clear());
    return true;
  } catch { return false; }
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
