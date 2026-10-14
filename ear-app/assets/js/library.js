/* 页面 1 · 动画选集 */

import { h, clear, icon, fmtTime, toast, tintFor } from './util.js';
import {
  getPrefs, setPrefs, getProgress, lastEpisodeId, getPasses, CACHE_CHOICES,
} from './store.js';
import { thumbUrl, groupBySeries } from './content.js';
import { stats, enforceBudget, clearAll, fmtMB } from './cache.js';

function statusOf(ep) {
  if (!ep.video && ep.source !== 'imported') {
    return { kind: 'danger', label: '缺视频', iconName: 'alert' };
  }
  if (!ep.lineCount && !(ep.lines && ep.lines.length)) {
    return { kind: 'amber', label: '字幕待整理', iconName: 'alert' };
  }
  if (ep.subtitleStatus === 'verified') {
    return { kind: 'green', label: '已校对', iconName: 'check' };
  }
  return { kind: 'blue', label: '自动字幕 · 待校对', iconName: 'info' };
}

function episodeCard(ep, onOpen) {
  const st = statusOf(ep);
  const tu = thumbUrl(ep);
  const playable = st.kind !== 'danger';

  const thumb = h('div.ep-thumb', { style: { background: tintFor(ep.id) } });
  if (tu) {
    // 内容全在本地，缩略图仅 ~20KB/张：直接加载，避免懒加载造成的首屏空占位
    thumb.appendChild(h('img', { src: tu, alt: '', decoding: 'async' }));
  }
  thumb.appendChild(h('span.ep-thumb-no', `第 ${String(ep.order).padStart(2, '0')} 集`));
  if (ep.durationSeconds) thumb.appendChild(h('span.ep-thumb-dur', fmtTime(ep.durationSeconds)));
  if (playable) {
    thumb.appendChild(h('div.ep-thumb-play', h('span', icon('play'))));
  }

  const passes = getPasses(ep.id);
  const footRight = passes > 0
    ? h('span.ep-pass', icon('ear'), `已听 ${passes} 遍`)
    : h('span.ep-count', ep.lineCount ? `${ep.lineCount} 句` : '—');

  const card = h('button.ep-card', {
    type: 'button',
    'aria-disabled': String(!playable),
    'aria-label': `第 ${ep.order} 集 ${ep.title}`,
    onclick: () => playable ? onOpen(ep) : toast('这一集缺少视频文件，无法播放'),
  },
    thumb,
    h('div.ep-body',
      h('h3.ep-title', ep.title),
      h('div.ep-foot',
        h('span.badge', { class: `badge-${st.kind}` }, icon(st.iconName), st.label),
        footRight,
      ),
    ),
  );
  return card;
}

/* ---------------------------------------------------------- 播放与存储设置
 *
 * 为什么放这里而不是工作台：工作台的控制条已经有 6 组按钮，再加就折行了；
 * 而且「清缓存」是低频操作，放在选集页这类「入口页」更自然。
 * 工作台里只留一个状态角标（本机播放 / 缓存中 xx%）。
 */

function miniSeg(defs, current, onPick) {
  const seg = h('div.seg.seg-mini');
  const btns = defs.map(([val, label]) => {
    const b = h('button', {
      type: 'button', 'aria-pressed': String(val === current),
      onclick: () => {
        onPick(val);
        btns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.val === String(val))));
      },
    }, label);
    b.dataset.val = String(val);
    seg.appendChild(b);
    return b;
  });
  return seg;
}

function storageCard(episodes) {
  const prefs = getPrefs();
  const validIds = new Set(episodes.map((e) => e.id));

  const usageText = h('span.cache-usage-text', '统计中…');
  const barFill = h('div.cache-bar-fill');
  const bar = h('div.cache-bar', barFill);
  const clearBtn = h('button.btn.btn-mini', { type: 'button' }, icon('trash'), '清空缓存');

  const refresh = async (budgetMB = getPrefs().cacheBudgetMB) => {
    const { bytes, count } = await stats();
    const budget = budgetMB > 0 ? budgetMB * 1024 * 1024 : 0;
    usageText.textContent = count
      ? `${count} 集 · ${fmtMB(bytes)}${budget ? ` / 上限 ${fmtMB(budget)}` : '（不限）'}`
      : '还没有缓存任何视频';
    barFill.style.width = budget ? `${Math.min(100, (bytes / budget) * 100)}%` : (count ? '100%' : '0%');
    bar.dataset.full = String(budget > 0 && bytes / budget > 0.9);
  };

  let armed = false;
  let armTimer = 0;
  clearBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      clearBtn.dataset.armed = '1';
      clearBtn.lastChild.textContent = '再点一次清空';
      armTimer = setTimeout(() => {
        armed = false;
        clearBtn.dataset.armed = '0';
        clearBtn.lastChild.textContent = '清空缓存';
      }, 3500);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    clearBtn.dataset.armed = '0';
    clearBtn.lastChild.textContent = '清空缓存';
    await clearAll();
    toast('本机缓存已清空');
    refresh();
  });

  const card = h('div.settings-card',
    h('div.settings-head',
      h('span.field-label', '播放与存储'),
      h('span.settings-sub', '这些设置对每一集都生效'),
    ),
    h('div.settings-row',
      h('div.sr-label', '播放时屏幕常亮',
        h('span.sr-hint', '单句 / 跟读模式每到句尾都会暂停，开着才不会中途锁屏')),
      miniSeg([[true, '开'], [false, '关']], prefs.keepAwake !== false, (v) => {
        setPrefs({ keepAwake: v });
        toast(v ? '播放期间会保持屏幕常亮' : '已允许系统自动锁屏');
      }),
    ),
    h('div.settings-row',
      h('div.sr-label', '视频存到本机',
        h('span.sr-hint', '存一份到 iPad 里，跳转 / 单句定位不再走网络，明显更跟手')),
      miniSeg([['auto', '开'], ['off', '关']], prefs.videoCache, (v) => {
        setPrefs({ videoCache: v });
        toast(v === 'auto' ? '打开一集后会自动存到本机' : '只用网络播放，不再缓存新视频');
      }),
    ),
    h('div.settings-row.settings-row-block',
      h('div.sr-label', '本机缓存用量'),
      h('div.cache-usage', usageText),
      bar,
      h('div.cache-actions',
        h('span.cache-budget-label', '上限'),
        miniSeg(CACHE_CHOICES.map((mb) => [mb, mb ? `${mb}MB` : '不限']), prefs.cacheBudgetMB, async (mb) => {
          setPrefs({ cacheBudgetMB: mb });
          const r = await enforceBudget(mb, validIds);
          toast(r.removed ? `上限已设为 ${mb ? mb + 'MB' : '不限'}，清理了 ${r.removed} 集` : `上限已设为 ${mb ? mb + 'MB' : '不限'}`);
          refresh(mb);
        }),
        clearBtn,
      ),
    ),
  );

  /* 进到选集页就是「合理时间」：先按预算淘汰，再显示真实用量 */
  (async () => {
    try {
      await enforceBudget(prefs.cacheBudgetMB, validIds);
      await refresh();
    } catch { usageText.textContent = '无法读取缓存（浏览器存储不可用）'; }
  })();

  return card;
}

export function renderLibrary(host, catalog, ctx) {
  clear(host);
  const { episodes, error } = catalog;

  const page = h('div.page');

  /* 标题区 */
  const head = h('div.page-head',
    h('div',
      h('h1.page-title', '动画选集'),
      h('p.page-desc', '选一集，进入磨耳朵工作台。连续播放看剧情，单句模式反复听一句；字幕就是导航。'),
    ),
    h('div.topbar-actions',
      h('button.btn.btn-icon', {
        type: 'button', title: '重新读取内容清单', 'aria-label': '重新读取内容清单',
        onclick: () => ctx.reload(),
      }, icon('spinner')),
    ),
  );
  page.appendChild(head);

  /* 读取失败 */
  if (error && !episodes.length) {
    page.appendChild(h('div.empty',
      h('div.empty-mark', icon('alert')),
      h('h2', '读不到内容清单'),
      h('p', '没有找到 content/episodes.json。请先运行内容整理脚本，或用「内容整理」页导入视频与字幕。'),
      h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' } },
        h('button.btn.btn-primary', { type: 'button', onclick: () => ctx.go('#/import') }, icon('folder'), '去内容整理'),
      ),
      h('p', { style: { marginTop: '14px', fontSize: '12px', color: 'var(--ink-3)' } },
        `技术细节：${error.message}`),
    ));
    host.appendChild(page);
    return;
  }

  /* 空状态 */
  if (!episodes.length) {
    page.appendChild(h('div.empty',
      h('div.empty-mark', icon('library')),
      h('h2', '还没有可以磨耳朵的动画'),
      h('p', '先用内容整理脚本挂载本地视频与字幕，或在「内容整理」页导入一集。'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => ctx.go('#/import') },
        icon('folder'), '打开内容整理'),
    ));
    host.appendChild(page);
    return;
  }

  /* 继续上次 */
  const lastId = lastEpisodeId();
  const lastEp = lastId ? episodes.find((e) => e.id === lastId) : null;
  const prog = lastEp ? getProgress(lastEp.id) : null;
  if (lastEp && prog && prog.lastPositionSeconds > 3) {
    const tu = thumbUrl(lastEp);
    const cont = h('div.continue-card',
      h('div.continue-thumb', tu ? h('img', { src: tu, alt: '' }) : icon('play')),
      h('div.continue-meta',
        h('div.continue-kicker', `${lastEp.seriesMeta ? `${lastEp.seriesMeta.title} · ` : ''}继续磨耳朵`),
        h('h2.continue-title', `第 ${String(lastEp.order).padStart(2, '0')} 集 · ${lastEp.title}`),
        h('div.continue-pos', `上次听到 ${fmtTime(prog.lastPositionSeconds)}${prog.lastLineIndex != null ? ` · 第 ${prog.lastLineIndex + 1} 句` : ''}`),
      ),
      h('button.btn.btn-primary', { type: 'button', onclick: () => ctx.go(`#/watch/${lastEp.id}`) },
        icon('play'), '继续'),
    );
    page.appendChild(cont);
  }

  /* 选集网格：按动画合集分节。只有一部动画时不显示分节标题，保持界面干净 */
  const groups = groupBySeries(catalog);
  const multi = groups.length > 1;
  groups.forEach(({ series, episodes: list }) => {
    const grid = h('div.ep-grid');
    list.forEach((ep) => grid.appendChild(episodeCard(ep, (e) => ctx.go(`#/watch/${e.id}`))));
    if (!multi) { page.appendChild(grid); return; }
    page.appendChild(h('section.series-block',
      h('div.series-head',
        h('h2.series-title', series.title),
        series.subtitle ? h('span.series-sub', series.subtitle) : null,
        h('span.series-count', `${list.length} 集`),
      ),
      series.desc ? h('p.series-desc', series.desc) : null,
      grid,
    ));
  });

  /* 播放与存储（屏幕常亮 / 本机缓存 / 清缓存） */
  page.appendChild(storageCard(episodes));

  /* 页脚说明 */
  const mounted = episodes.filter((e) => e.source === 'mounted').length;
  const imported = episodes.filter((e) => e.source === 'imported').length;
  const seriesNote = groups.length > 1
    ? `${groups.map((g) => `${g.series.title} ${g.episodes.length} 集`).join(' · ')}。`
    : '';
  page.appendChild(h('p', {
    style: { margin: '4px 0 0', fontSize: '12.5px', color: 'var(--ink-3)', lineHeight: '1.6' },
  }, `共 ${episodes.length} 集 · 本地挂载 ${mounted} 集 · 浏览器导入 ${imported} 集。${seriesNote}`
    + '字幕由人工字幕 / 语音识别整理并已按时序对齐，逐句核对后可标记为「已校对」。'));

  host.appendChild(page);
}
