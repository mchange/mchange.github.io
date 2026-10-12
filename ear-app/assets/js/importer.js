/* 页面 3 · 本地内容整理入口
 *
 * 两条内容来源：
 *   A. 挂载（推荐）：视频/字幕放在 downloads/ 下，由 scripts/build_content.py 生成清单，零存储风险
 *   B. 导入：视频 Blob 写入 IndexedDB（方案 A），可在 iPad 上直接补内容
 */

import { h, clear, append, icon, toast, fmtTime, fmtBytes } from './util.js';
import { parseSrt, mergeSentences, attachChinese, toLines, validate } from './srt.js';
import {
  putImportedEpisode, deleteImportedEpisode,
  storageEstimate, persistStorage, setVerified,
} from './store.js';
import { invalidateCatalog, invalidateLines, loadLines } from './content.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const SUB_EXT = /\.(srt|vtt)$/i;

/* -------------------------------------------------------------- 媒体探测 */

function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve({ url, el: v, ...res }); } };
    const timer = setTimeout(() => done({ ok: false, reason: '读取超时（文件可能过大或不可解码）' }), 25000);

    v.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      done({
        ok: true,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        width: v.videoWidth,
        height: v.videoHeight,
      });
    });
    v.addEventListener('error', () => {
      clearTimeout(timer);
      const c = v.error ? v.error.code : 0;
      const why = { 3: '解码失败：编码不被浏览器支持', 4: '格式不受支持' }[c] || '媒体错误';
      done({ ok: false, reason: `${why}（错误码 ${c || '未知'}）` });
    });
    v.src = url;
  });
}

function grabThumb(videoEl, at) {
  return new Promise((resolve) => {
    try {
      const w = 480, hh = 270;
      videoEl.currentTime = at;
      const onSeeked = () => {
        videoEl.removeEventListener('seeked', onSeeked);
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = hh;
          c.getContext('2d').drawImage(videoEl, 0, 0, w, hh);
          resolve(c.toDataURL('image/jpeg', 0.72));
        } catch { resolve(null); }
      };
      videoEl.addEventListener('seeked', onSeeked);
      setTimeout(() => resolve(null), 6000);
    } catch { resolve(null); }
  });
}

/* -------------------------------------------------------------- 面板 */

function panelSource(catalog, extra) {
  const mounted = catalog.episodes.filter((e) => e.source === 'mounted').length;
  const imported = catalog.episodes.filter((e) => e.source === 'imported').length;
  const el = h('section.card.panel');
  append(el,
    h('h2', icon('library'), '内容源状态'),
    h('div.stat-row',
      h('div.stat', h('div.stat-num', String(mounted)), h('div.stat-key', '本地挂载（downloads/）')),
      h('div.stat', h('div.stat-num', String(imported)), h('div.stat-key', '浏览器导入（IndexedDB）')),
      h('div.stat', h('div.stat-num', String(extra.totalLines)), h('div.stat-key', '可精听句数')),
    ),
    h('p.hint', '挂载内容不占用浏览器存储，删除 downloads 里的文件就会消失；导入内容保存在浏览器里，清理 Safari 数据会一并清掉。'),
    extra.storageRow,
  );
  return el;
}

/* -------------------------------------------------------------- 页面 */

export async function renderImport(host, ctx) {
  clear(host);
  const catalog = await ctx.catalog();

  const totalLines = catalog.episodes.reduce((n, e) => n + (e.lineCount || 0), 0);

  /* --- 存储状态 --- */
  const est = await storageEstimate();
  const storageRow = h('div.vlist', { style: { maxHeight: 'none' } });
  storageRow.appendChild(h('div.vrow.v-ok',
    h('span.vrow-icon', icon('info')),
    h('span.vrow-body',
      h('span.vrow-title', '浏览器存储'),
      h('span.vrow-msg', est
        ? `已用 ${fmtBytes(est.usage)} / 配额约 ${fmtBytes(est.quota)}`
        : '此浏览器不提供配额信息。'),
    ),
  ));
  const persistBtn = h('button.btn', {
    type: 'button',
    onclick: async () => {
      const ok = await persistStorage();
      toast(ok ? '已申请持久化存储，浏览器清理数据时会优先保留' : '浏览器未授予持久化存储（通常是 Safari 的默认行为）');
    },
  }, icon('check'), '申请持久化存储');

  const page = h('div.page');
  page.appendChild(h('div.page-head',
    h('div',
      h('h1.page-title', '内容整理'),
      h('p.page-desc', '这里负责准备素材：视频 + 中英文字幕。整理好之后，孩子就只在「动画选集」里使用。'),
    ),
    h('div.topbar-actions',
      persistBtn,
      h('button.btn', { type: 'button', onclick: () => ctx.go('#/library') }, icon('back'), '回到选集'),
    ),
  ));

  const grid = h('div.import-grid');
  page.appendChild(grid);

  grid.appendChild(panelSource(catalog, { totalLines, storageRow }));

  /* --- 已整理内容 + 校对 --- */
  const listPanel = h('section.card.panel');
  const listBody = h('div.vlist');
  append(listPanel, h('h2', icon('check'), '已整理内容与校对状态'),
    h('p.hint', '自动字幕默认标记为「待校对」。逐句听过、确认过时间轴与英文之后，可以标记为已校对。'),
    listBody);
  grid.appendChild(listPanel);

  let selectedId = catalog.episodes[0] ? catalog.episodes[0].id : null;

  function paintList() {
    clear(listBody);
    if (!catalog.episodes.length) {
      listBody.appendChild(h('div.vrow', h('span.vrow-body', h('span.vrow-msg', '还没有内容。'))));
      return;
    }
    for (const ep of catalog.episodes) {
      const verified = ep.subtitleStatus === 'verified';
      const zhCount = ep.lineCount ? null : null;
      const row = h('div.vrow', { class: verified ? 'v-ok' : 'v-warn' },
        h('span.vrow-icon', icon(verified ? 'check' : 'alert')),
        h('span.vrow-body',
          h('span.vrow-title', `第 ${String(ep.order).padStart(2, '0')} 集 · ${ep.title}`),
          h('span.vrow-msg',
            `${ep.lineCount || 0} 句 · ${fmtTime(ep.durationSeconds || 0)} · `
            + `${ep.source === 'imported' ? '浏览器导入' : '本地挂载'}`),
        ),
        h('span', { style: { display: 'flex', gap: '6px', flexShrink: '0' } },
          h('button.btn', {
            type: 'button',
            onclick: () => { selectedId = ep.id; paintDetail(); },
          }, '看字幕'),
          h('button.btn', {
            type: 'button',
            onclick: () => {
              setVerified(ep.id, !verified);
              ep.subtitleStatus = !verified ? 'verified' : 'draft';
              toast(!verified ? '已标记为已校对' : '已改回待校对');
              paintList();
            },
          }, verified ? '撤销' : '标记已校对'),
          ep.source === 'imported'
            ? h('button.btn.btn-icon', {
                type: 'button', title: '删除这一集',
                onclick: async () => {
                  await deleteImportedEpisode(ep.id);
                  invalidateCatalog(); invalidateLines(ep.id);
                  toast('已删除导入的这一集');
                  await ctx.reload();
                },
              }, icon('trash'))
            : null,
        ),
      );
      listBody.appendChild(row);
    }
  }

  /* --- 逐句预览 --- */
  const detailPanel = h('section.card.panel', { style: { gridColumn: '1 / -1' } });
  const detailBody = h('div.vlist', { style: { maxHeight: '420px' } });
  append(detailPanel, h('h2', icon('info'), '字幕逐句预览'), detailBody);
  grid.appendChild(detailPanel);

  async function paintDetail() {
    clear(detailBody);
    const ep = catalog.episodes.find((e) => e.id === selectedId) || catalog.episodes[0];
    if (!ep) return;
    const lines = await loadLines(ep);
    const v = validate({
      lines,
      durationSeconds: ep.durationSeconds,
      hasVideo: true,
      hasZhTrack: lines.some((l) => String(l.zh || '').trim()),
    });
    detailBody.appendChild(h('div.vrow', {
      class: v.issues.some((i) => i.level === 'err') ? 'v-err'
        : v.issues.some((i) => i.level === 'warn') ? 'v-warn' : 'v-ok',
    },
      h('span.vrow-icon', icon(v.issues.some((i) => i.level === 'ok') ? 'check' : 'alert')),
      h('span.vrow-body',
        h('span.vrow-title', `第 ${String(ep.order).padStart(2, '0')} 集 · ${ep.title} · 校验结果`),
        h('span.vrow-msg', `${v.stats.total} 句 · 中文提示 ${v.stats.withZh} 句 · 重叠 ${v.stats.overlaps} 处 · 越界 ${v.stats.outOfRange} 处`),
      ),
    ));
    for (const i of v.issues) {
      if (i.level === 'ok') continue;
      detailBody.appendChild(h('div.vrow', { class: i.level === 'err' ? 'v-err' : 'v-warn' },
        h('span.vrow-icon', icon('alert')),
        h('span.vrow-body', h('span.vrow-title', i.title), h('span.vrow-msg', i.msg)),
      ));
    }
    for (const L of lines.slice(0, 400)) {
      detailBody.appendChild(h('div.vrow',
        h('span.vrow-icon', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', width: 'auto', color: 'var(--ink-3)' } },
          `${String(Math.floor(L.start / 60)).padStart(2, '0')}:${String(Math.floor(L.start % 60)).padStart(2, '0')}`),
        h('span.vrow-body',
          h('span.vrow-title', L.en),
          h('span.vrow-msg', String(L.zh || '').trim() || '（无中文提示）'),
        ),
      ));
    }
    if (lines.length > 400) {
      detailBody.appendChild(h('div.vrow', h('span.vrow-body', h('span.vrow-msg', `仅显示前 400 句，共 ${lines.length} 句。`))));
    }
  }

  /* --- 导入面板 --- */
  const importPanel = h('section.card.panel');
  grid.appendChild(importPanel);

  const state = { videoFile: null, probe: null, subs: [], title: '', order: null, thumb: null, lines: null, validation: null };

  const videoInput = h('input', {
    type: 'file', accept: 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov', hidden: true,
  });
  const subInput = h('input', {
    type: 'file', accept: '.srt,.vtt,text/plain', multiple: true, hidden: true,
  });

  const videoDrop = h('label.drop', { 'aria-label': '选择视频文件' },
    icon('download'),
    h('strong', '选择或拖入视频'),
    h('small', 'MP4（H.264 + AAC）在 iPad Safari 上最稳；AV1 只在较新的 iPad 上能解码'),
    videoInput,
  );
  const subDrop = h('label.drop', { 'aria-label': '选择字幕文件' },
    icon('download'),
    h('strong', '选择或拖入字幕'),
    h('small', 'SRT / VTT，可一次选英文与中文两个文件（按文件名自动分配）'),
    subInput,
  );

  function bindDrop(el, onFiles) {
    ['dragenter', 'dragover'].forEach((ev) =>
      el.addEventListener(ev, (e) => { e.preventDefault(); el.dataset.over = '1'; }));
    ['dragleave', 'drop'].forEach((ev) =>
      el.addEventListener(ev, (e) => { e.preventDefault(); el.dataset.over = '0'; }));
    el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (files.length) onFiles(files);
    });
  }
  bindDrop(videoDrop, (files) => {
    const f = files.find((x) => VIDEO_EXT.test(x.name)) || files[0];
    handleVideo(f);
  });
  bindDrop(subDrop, handleSubs);

  const statusBox = h('div.vlist', { style: { maxHeight: 'none' } });
  const titleInput = h('input', {
    type: 'text', placeholder: '例如：The Alarm', value: '',
    style: {
      width: '100%', minHeight: '44px', padding: '0 12px', fontSize: '15px',
      border: '1px solid var(--line-strong)', borderRadius: '11px',
      background: 'var(--surface-2)', color: 'var(--ink)', fontFamily: 'inherit',
    },
    oninput: (e) => { state.title = e.target.value; },
  });
  const orderInput = h('input', {
    type: 'number', min: '1', step: '1', value: '',
    style: {
      width: '100%', minHeight: '44px', padding: '0 12px', fontSize: '15px',
      border: '1px solid var(--line-strong)', borderRadius: '11px',
      background: 'var(--surface-2)', color: 'var(--ink)', fontFamily: 'inherit',
    },
    oninput: (e) => { state.order = parseInt(e.target.value, 10) || null; },
  });

  const saveBtn = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: saveImport },
    icon('check'), '保存到浏览器');

  append(importPanel,
    h('h2', icon('folder'), '导入新内容'),
    h('p.hint', '给家长 / 维护者使用。导入的视频会存进这台设备的浏览器里，孩子端不需要联网。'),
    videoDrop,
    subDrop,
    h('div', h('div.field-label', { style: { marginBottom: '6px' } }, '集数标题'), titleInput),
    h('div', h('div.field-label', { style: { marginBottom: '6px' } }, '排序号（可选，默认排到最后）'), orderInput),
    statusBox,
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      saveBtn,
      h('button.btn', {
        type: 'button',
        onclick: () => { resetImport(); },
      }, '清空'),
    ),
  );

  function resetImport() {
    if (state.probe && state.probe.url) URL.revokeObjectURL(state.probe.url);
    Object.assign(state, { videoFile: null, probe: null, subs: [], title: '', order: null, thumb: null, lines: null, validation: null });
    titleInput.value = ''; orderInput.value = '';
    paintStatus();
  }

  async function handleVideo(file) {
    if (!file) return;
    if (!VIDEO_EXT.test(file.name)) { toast('请选择 mp4 / mov / webm 视频文件'); return; }
    if (state.probe && state.probe.url) URL.revokeObjectURL(state.probe.url);
    state.videoFile = file;
    state.probe = null;
    paintStatus('正在读取视频信息…');
    const probe = await probeVideo(file);
    state.probe = probe;
    if (probe.ok) {
      if (!state.title) {
        state.title = file.name.replace(VIDEO_EXT, '').replace(/^\d+\s*/, '').trim();
        titleInput.value = state.title;
      }
      if (!state.order) {
        const maxOrder = Math.max(0, ...catalog.episodes.map((e) => e.order || 0));
        state.order = maxOrder + 1;
        orderInput.value = String(state.order);
      }
    }
    paintStatus();
  }

  function handleSubs(files) {
    const subs = files.filter((f) => SUB_EXT.test(f.name));
    if (!subs.length) { toast('请选择 .srt 或 .vtt 字幕文件'); return; }
    state.subs = subs.map((f) => ({
      file: f,
      lang: /(^|[._-])(en|eng|english)/i.test(f.name) ? 'en'
          : /(zh|chs|cht|hans|hant|中文|简|繁)/i.test(f.name) ? 'zh' : 'en',
    }));
    paintStatus();
  }

  async function buildPreview() {
    const subs = state.subs;
    if (!subs.length) { state.lines = null; return; }
    const enSub = subs.find((s) => s.lang === 'en') || subs[0];
    const zhSub = subs.find((s) => s.lang === 'zh');
    const enText = await enSub.file.text();
    const enCues = parseSrt(enText);
    const sentences = mergeSentences(enCues);
    let finalLines;
    if (zhSub) {
      const zhCues = parseSrt(await zhSub.file.text());
      finalLines = toLines(attachChinese(sentences, zhCues));
    } else {
      finalLines = toLines(sentences.map((s) => ({ ...s, zh: '' })));
    }
    state.lines = finalLines;
    state.validation = validate({
      lines: finalLines,
      durationSeconds: state.probe && state.probe.ok ? state.probe.duration : null,
      hasVideo: !!(state.probe && state.probe.ok),
      hasZhTrack: !!zhSub,
    });
  }

  function paintStatus(busyText) {
    clear(statusBox);
    if (busyText) {
      statusBox.appendChild(h('div.vrow', h('span.vrow-icon', icon('info')),
        h('span.vrow-body', h('span.vrow-msg', busyText))));
      return;
    }
    if (state.videoFile) {
      const ok = state.probe && state.probe.ok;
      statusBox.appendChild(h('div.vrow', { class: ok ? 'v-ok' : 'v-err' },
        h('span.vrow-icon', icon(ok ? 'check' : 'alert')),
        h('span.vrow-body',
          h('span.vrow-title', `视频：${state.videoFile.name}`),
          h('span.vrow-msg', ok
            ? `${fmtBytes(state.videoFile.size)} · ${state.probe.width}×${state.probe.height} · ${fmtTime(state.probe.duration)} · ${state.videoFile.type || '未知类型'}`
            : `无法读取：${state.probe ? state.probe.reason : '未知原因'}。若为 AV1 编码，请先转成 H.264。`),
        ),
      ));
    }
    if (state.subs.length) {
      for (const s of state.subs) {
        statusBox.appendChild(h('div.vrow.v-ok',
          h('span.vrow-icon', icon('check')),
          h('span.vrow-body',
            h('span.vrow-title', `字幕（${s.lang === 'en' ? '英文' : '中文'}）：${s.file.name}`),
            h('span.vrow-msg', fmtBytes(s.file.size)),
          ),
          h('button.btn', {
            type: 'button',
            onclick: () => { s.lang = s.lang === 'en' ? 'zh' : 'en'; buildPreview().then(paintStatus); },
          }, '切换为' + (s.lang === 'en' ? '中文' : '英文')),
        ));
      }
    }
    if (state.validation) {
      for (const i of state.validation.issues) {
        statusBox.appendChild(h('div.vrow', { class: i.level === 'err' ? 'v-err' : i.level === 'warn' ? 'v-warn' : 'v-ok' },
          h('span.vrow-icon', icon(i.level === 'ok' ? 'check' : 'alert')),
          h('span.vrow-body', h('span.vrow-title', i.title), h('span.vrow-msg', i.msg)),
        ));
      }
    }
    saveBtn.disabled = !(state.probe && state.probe.ok && state.lines && state.lines.length);
  }

  /* 选文件与拖拽统一走 pick* 包装：拿到素材后立即重建预览与校验 */
  async function pickVideo(file) {
    await handleVideo(file);
    await buildPreview();
    paintStatus();
  }
  function pickSubs(files) {
    handleSubs(files);
    buildPreview().then(() => paintStatus());
  }
  videoInput.addEventListener('change', (e) => pickVideo(e.target.files[0]));
  subInput.addEventListener('change', (e) => pickSubs([...e.target.files]));

  async function saveImport() {
    saveBtn.disabled = true;
    try {
      // 缩略图
      let thumbDataUrl = null;
      if (state.probe && state.probe.ok && state.probe.el) {
        const at = Math.min(12, Math.max(1, (state.probe.duration || 30) * 0.05));
        thumbDataUrl = await grabThumb(state.probe.el, at);
      }
      const id = `imp${Date.now().toString(36)}`;
      const record = {
        id,
        order: state.order || (Math.max(0, ...catalog.episodes.map((e) => e.order || 0)) + 1),
        title: state.title || state.videoFile.name.replace(VIDEO_EXT, ''),
        durationSeconds: state.probe.duration,
        subtitleStatus: 'draft',
        lineCount: state.lines.length,
        lines: state.lines,
        thumbnailDataUrl: thumbDataUrl,
        fileName: state.videoFile.name,
        mimeType: state.videoFile.type,
        sizeBytes: state.videoFile.size,
        importedAt: new Date().toISOString(),
      };
      await putImportedEpisode(record, state.videoFile);
      await persistStorage();
      toast('已保存到浏览器，选集页可以直接打开');
      resetImport();
      invalidateCatalog();
      await ctx.reload();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`);
      saveBtn.disabled = false;
    }
  }

  host.appendChild(page);
  paintList();
  paintStatus();
  await paintDetail();
}
