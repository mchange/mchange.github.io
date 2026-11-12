/* 内容整理 · 本机视频配置
 *
 * 需求：家长把 mp4 存到 iPad「文件」App，在这里选一次，之后播放直接读本机；
 *       没配置的集照常从网络加载。
 *
 * 实现要点：
 *   - 复用已有的 vcache/vmeta（原本用于「播放时自动缓存」），videoSources() 本来就是
 *     「本机 blob 优先 → 网络地址兜底」，所以播放器一行都不用改；
 *   - 手动写入的条目标 origin='manual'，豁免 enforceBudget() 的 LRU 淘汰；
 *   - iPad 网页读不到「文件」App 的任意路径，只能由用户选一次文件，再把 Blob 存进
 *     IndexedDB；选完就常驻，刷新 / 断网都在（除非清理网站数据）。
 */

import {
  h, clear, append, icon, toast, fmtBytes,
} from './util.js';
import {
  stats, putLocalVideo, removeLocalVideo, localVideoMap, fmtMB,
} from './cache.js';
import { invalidateVideoSource } from './content.js';
import { storageEstimate } from './store.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm';

/* ------------------------------------------------------------ 文件名匹配 */

const basename = (p) => String(p || '').split('/').pop();

/** 归一化：去扩展名 / 去「(1)」副本后缀 / 统一分隔符与空白 / 小写 */
function norm(s) {
  return String(s || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s*\(\d+\)\s*$/g, '')
    .replace(/[_\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 建索引；冲突的 key 置 null（歧义，不敢自动配错集） */
function buildIndex(episodes) {
  const idx = new Map();
  const add = (k, id) => {
    if (!k) return;
    if (!idx.has(k)) idx.set(k, id);
    else if (idx.get(k) !== id) idx.set(k, null);
  };
  for (const ep of episodes) {
    add(norm(basename(ep.video)), ep.id);
    add(norm(ep.id), ep.id);
    add(norm(ep.title), ep.id);
    add(norm(`${String(ep.order).padStart(2, '0')} ${ep.title}`), ep.id);
  }
  return idx;
}

/**
 * 文件 → 剧集。返回 { id, how } 或 null。
 * 精确文件名匹配最可靠；序号 + 标题关键词只作为兜底，并在预览里标「猜测」让用户核对。
 */
function matchEpisode(fileName, episodes, idx) {
  const key = norm(fileName);
  if (idx.has(key) && idx.get(key)) return { id: idx.get(key), how: 'exact' };

  // 包含匹配：文件名里带完整剧名，且全库只匹配到一集
  const contains = episodes.filter((ep) => {
    const t = norm(ep.title);
    return t.length >= 5 && key.includes(t);
  });
  if (contains.length === 1) return { id: contains[0].id, how: 'title' };

  // 序号兜底：只在全库同序号唯一时用（多个系列都有「第 01 集」，多数情况会故意不匹配）
  const m = key.match(/^(\d{1,2})\b/);
  if (m) {
    const n = Number(m[1]);
    const same = episodes.filter((ep) => Number(ep.order) === n);
    if (same.length === 1) return { id: same[0].id, how: 'number' };
  }
  return null;
}

/* ---------------------------------------------------------------- 面板 */

export function createLocalVideoPanel(catalog) {
  /* 导入的新集本来就存在浏览器里，不需要再配本机视频 */
  const episodes = (catalog.episodes || [])
    .filter((ep) => ep.source !== 'imported' && ep.video);
  const byId = new Map(episodes.map((ep) => [ep.id, ep]));
  const idx = buildIndex(episodes);

  const labelOf = (ep) => {
    const st = (catalog.series || []).find((s) => s.id === ep.series);
    const head = ep.epLabel ? ep.epLabel : `第 ${String(ep.order).padStart(2, '0')} 集`;
    return `${st ? `${st.title} · ` : ''}${head}${ep.epLabel ? '' : ` ${ep.title || ''}`}`.trim();
  };

  const panel = h('section.card.panel', {
    id: 'local-video-panel',
    style: { gridColumn: '1 / -1' },
  });

  append(panel,
    h('h2', icon('folder'), '本机视频（iPad 离线看）'),
    h('p.hint',
      '把 mp4 存进 iPad 的「文件」App 后，在这里选一次，网页就会把它存进这台设备的浏览器里；',
      '之后刷新、断网都能直接播放，不用再选。', h('strong', '没配置的集照常从网上加载。')),
    h('p.hint',
      'iPad 网页读不到「文件」App 的任意文件夹，所以第一次必须手动选文件。',
      '手动配置的视频不会被「缓存上限」自动清掉；清理 Safari 网站数据会一并清掉，无痕模式下不会保存。'),
    h('p.hint',
      '整库视频体积可能超过 Safari 给单个网站的存储配额，', h('strong', '建议只配置常看的几集'),
      '；空间不够时会明确提示，不会静默丢文件。'),
  );

  /* 状态条（配额 + 汇总） */
  const quotaEl = h('div.vrow',
    h('span.vrow-icon', icon('info')),
    h('span.vrow-body', h('span.vrow-msg', '正在读取本机存储…')));
  panel.appendChild(quotaEl);

  /* 批量选择 */
  const batchInput = h('input', {
    type: 'file', accept: ACCEPT, multiple: true, hidden: true,
    'aria-label': '批量选择本机视频文件',
  });
  const pickBtn = h('button.btn.btn-primary', {
    type: 'button', onclick: () => batchInput.click(),
  }, icon('download'), '批量选择视频文件');
  const clearPendingBtn = h('button.btn', {
    type: 'button', hidden: true, onclick: () => { pending = []; paintPending(); },
  }, '清空待导入');
  panel.appendChild(h('div.lv-toolbar', pickBtn, clearPendingBtn, batchInput,
    h('span.lv-toolbar-hint', '可一次选多集；按文件名自动对应，对不上的可以手动改')));

  /* 待导入预览（两步确认，避免配错集） */
  const pendingBox = h('div.lv-pending', { hidden: true });
  panel.appendChild(pendingBox);

  /* 过滤 */
  const filterInput = h('input.lv-search', {
    type: 'search', placeholder: '搜索剧集名…',
    'aria-label': '搜索剧集',
    oninput: () => paintList(),
  });
  const onlyMissing = h('input', { type: 'checkbox', 'aria-label': '只看未配置' });
  onlyMissing.addEventListener('change', paintList);
  const filterLabel = h('label.lv-check', onlyMissing, '只看未配置');
  panel.appendChild(h('div.lv-toolbar', filterInput, filterLabel));

  /* 剧集列表 */
  const listEl = h('div.vlist.lv-list');
  panel.appendChild(listEl);

  /* 逐集选文件共用一个 input，点按钮时记下目标集 */
  const singleInput = h('input', {
    type: 'file', accept: ACCEPT, hidden: true,
    'aria-label': '为这一集选择本机视频',
  });
  panel.appendChild(singleInput);
  let singleTarget = null;

  let pending = [];       // [{ file, id, how }]
  let metaMap = new Map(); // id → vmeta
  let st = { count: 0, bytes: 0, manualCount: 0, manualBytes: 0 };

  /* ------------------------------------------------------------ 渲染 */

  async function refresh() {
    [st, metaMap] = await Promise.all([stats(), localVideoMap()]);
    const est = await storageEstimate();
    const quota = est && est.quota ? ` / 可用约 ${fmtBytes(est.quota)}` : '';
    clear(quotaEl);
    append(quotaEl,
      h('span.vrow-icon', icon('info')),
      h('span.vrow-body',
        h('span.vrow-title',
          `本机已存 ${st.count} 集 · ${fmtMB(st.bytes)}`,
          st.manualCount ? h('span.lv-soft', `（其中手动配置 ${st.manualCount} 集 / ${fmtMB(st.manualBytes)}）`) : null),
        h('span.vrow-msg',
          `浏览器已用 ${est ? fmtBytes(est.usage) : '未知'}${quota}。`,
          '手动配置不占自动缓存上限，也不参与自动淘汰；清理网站数据会一起清掉。')));
    paintList();
  }

  function paintList() {
    clear(listEl);
    const q = String(filterInput.value || '').trim().toLowerCase();
    const missingOnly = onlyMissing.checked;
    const shown = episodes.filter((ep) => {
      const meta = metaMap.get(ep.id);
      if (missingOnly && meta) return false;
      if (!q) return true;
      return `${labelOf(ep)} ${ep.id} ${basename(ep.video)}`.toLowerCase().includes(q);
    });
    if (!shown.length) {
      listEl.appendChild(h('div.vrow',
        h('span.vrow-body', h('span.vrow-msg', '没有符合条件的剧集。'))));
      return;
    }
    let lastSeries = null;
    for (const ep of shown) {
      if (ep.series !== lastSeries) {
        lastSeries = ep.series;
        const s = (catalog.series || []).find((x) => x.id === ep.series);
        listEl.appendChild(h('div.lv-group', s ? s.title : ep.series || '其它'));
      }
      const meta = metaMap.get(ep.id);
      const manual = meta && meta.origin === 'manual';
      const auto = meta && !manual;
      const status = manual ? `本机 · 手动配置 · ${fmtBytes(meta.size || 0)}`
        : auto ? `本机 · 自动缓存 · ${fmtBytes(meta.size || 0)}`
          : '未配置 · 播放时从网络加载';
      const detail = manual && meta.fileName ? `${status} · ${meta.fileName}` : status;

      const actions = h('span.lv-actions');
      actions.appendChild(h('button.btn.btn-mini', {
        type: 'button',
        'aria-label': `${manual ? '替换' : '配置'}${labelOf(ep)}的本机视频`,
        onclick: () => { singleTarget = ep.id; singleInput.value = ''; singleInput.click(); },
      }, manual ? '替换' : '选文件'));
      if (meta) {
        actions.appendChild(h('button.btn.btn-mini.btn-icon', {
          type: 'button', title: '移除本机视频，改从网络加载',
          'aria-label': `移除${labelOf(ep)}的本机视频`,
          onclick: () => removeOne(ep.id, labelOf(ep)),
        }, icon('trash')));
      }

      /* 只有「已手动配置」用绿底；未配置是常态（可能 30 多集），
         全部铺琥珀警告底会把整页染成一片橙 */
      listEl.appendChild(h('div.vrow', {
        class: manual ? 'v-ok' : '',
        dataset: { epId: ep.id, origin: manual ? 'manual' : auto ? 'auto' : 'none' },
      },
        h('span.vrow-icon', icon(manual ? 'check' : auto ? 'info' : 'download')),
        h('span.vrow-body',
          h('span.vrow-title', labelOf(ep)),
          h('span.vrow-msg', detail),
        ),
        actions,
      ));
    }
  }

  function paintPending() {
    clear(pendingBox);
    if (!pending.length) { pendingBox.hidden = true; clearPendingBtn.hidden = true; return; }
    pendingBox.hidden = false;
    clearPendingBtn.hidden = false;

    append(pendingBox,
      h('div.lv-pending-head',
        h('strong', `待写入 ${pending.length} 个文件`),
        h('span.lv-soft', '请核对对应剧集；文件名对不上的可以手动改'),
      ));

    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      const sel = h('select.lv-select', {
        'aria-label': `选择「${item.file.name}」对应的剧集`,
        onchange: (e) => { item.id = e.target.value || null; item.how = item.id ? 'manual' : null; },
      },
        h('option', { value: '' }, '— 不导入，选择剧集 —'),
        ...seriesOptions(),
      );
      sel.value = item.id || '';
      const guess = item.how === 'exact' ? '文件名匹配'
        : item.how === 'title' ? '按剧名猜测'
          : item.how === 'number' ? '按集号猜测'
            : '未匹配，请手动选择';
      append(pendingBox, h('div.vrow', {
        class: item.id ? (item.how === 'exact' ? 'v-ok' : 'v-warn') : 'v-err',
      },
        h('span.vrow-icon', icon(item.id ? 'check' : 'alert')),
        h('span.vrow-body',
          h('span.vrow-title', item.file.name),
          h('span.vrow-msg', `${fmtBytes(item.file.size)} · ${guess}`),
        ),
        sel,
        h('button.btn.btn-mini.btn-icon', {
          type: 'button', title: '从待导入里移除',
          'aria-label': `移除${item.file.name}`,
          onclick: () => { pending.splice(i, 1); paintPending(); },
        }, icon('trash')),
      ));
    }

    const okCount = pending.filter((p) => p.id).length;
    const writeBtn = h('button.btn.btn-primary', {
      type: 'button', disabled: !okCount,
      onclick: () => writePending(writeBtn, progress),
    }, icon('check'), `写入本机（${okCount}）`);
    const progress = h('span.lv-soft', '');
    append(pendingBox, h('div.lv-toolbar', writeBtn, progress));
  }

  let optionNodes = null;
  function seriesOptions() {
    if (optionNodes) return optionNodes.map((n) => n.cloneNode(true));
    optionNodes = [];
    for (const s of (catalog.series || [])) {
      const eps = episodes.filter((e) => e.series === s.id);
      if (!eps.length) continue;
      const group = h('optgroup', { label: s.title });
      for (const ep of eps) group.appendChild(h('option', { value: ep.id }, labelOf(ep)));
      optionNodes.push(group);
    }
    return optionNodes.map((n) => n.cloneNode(true));
  }

  /* ------------------------------------------------------------ 操作 */

  function collect(files) {
    const videos = files.filter((f) => VIDEO_EXT.test(f.name));
    if (!videos.length) { toast('没找到 mp4 / m4v / mov 视频文件'); return; }
    pending = videos.map((file) => {
      const m = matchEpisode(file.name, episodes, idx);
      return { file, id: m ? m.id : null, how: m ? m.how : null };
    });
    paintPending();
    const matched = pending.filter((p) => p.id).length;
    toast(`选中 ${pending.length} 个文件，自动对应 ${matched} 集`);
    pendingBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function writePending(btn, progress) {
    const items = pending.filter((p) => p.id);
    btn.disabled = true;
    let ok = 0;
    const failed = [];
    for (let i = 0; i < items.length; i += 1) {
      const { file, id } = items[i];
      const ep = byId.get(id);
      progress.textContent = `正在写入 ${i + 1}/${items.length}：${file.name} …`;
      // 让浏览器有机会把进度画出来（大文件写 IndexedDB 是同步感很强的操作）
      await new Promise((r) => setTimeout(r, 0));
      try {
        await putLocalVideo(id, file, {
          title: ep ? ep.title : '', durationSeconds: ep ? ep.durationSeconds : 0,
        });
        invalidateVideoSource(id);
        ok += 1;
      } catch (err) {
        failed.push(`${file.name}：${err && err.message ? err.message : err}`);
      }
    }
    pending = [];
    paintPending();
    await refresh();
    progress.textContent = '';
    if (failed.length) {
      append(pendingBox, h('div.vrow.v-err',
        h('span.vrow-icon', icon('alert')),
        h('span.vrow-body',
          h('span.vrow-title', `成功 ${ok} 集，失败 ${failed.length} 集`),
          ...failed.slice(0, 3).map((x) => h('span.vrow-msg', x)))));
      pendingBox.hidden = false;
    } else {
      toast(`已写入 ${ok} 集，播放时直接读本机`);
    }
  }

  async function removeOne(id, label) {
    await removeLocalVideo(id);
    invalidateVideoSource(id);
    await refresh();
    toast(`已移除「${label}」的本机视频，改从网络加载`);
  }

  async function writeSingle(file) {
    const id = singleTarget;
    singleTarget = null;
    if (!id || !file) return;
    if (!VIDEO_EXT.test(file.name)) { toast('请选择 mp4 / m4v / mov 视频文件'); return; }
    toast(`正在写入 ${file.name} …`);
    try {
      const ep = byId.get(id);
      await putLocalVideo(id, file, {
        title: ep ? ep.title : '', durationSeconds: ep ? ep.durationSeconds : 0,
      });
      invalidateVideoSource(id);
      await refresh();
      toast('已写入本机，播放时不再请求网络');
    } catch (err) {
      toast(`写入失败：${err && err.message ? err.message : err}`);
    }
  }

  batchInput.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) collect(files);
  });
  singleInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) writeSingle(f);
  });

  refresh().catch(() => {
    quotaEl.lastChild && (quotaEl.lastChild.textContent = '无法读取本机存储（浏览器存储不可用）');
  });
  return panel;
}
