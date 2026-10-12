/* 页面 1 · 动画选集 */

import { h, clear, icon, fmtTime, toast, tintFor } from './util.js';
import { getProgress, lastEpisodeId, getPasses } from './store.js';
import { thumbUrl } from './content.js';

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
        h('div.continue-kicker', '继续磨耳朵'),
        h('h2.continue-title', `第 ${String(lastEp.order).padStart(2, '0')} 集 · ${lastEp.title}`),
        h('div.continue-pos', `上次听到 ${fmtTime(prog.lastPositionSeconds)}${prog.lastLineIndex != null ? ` · 第 ${prog.lastLineIndex + 1} 句` : ''}`),
      ),
      h('button.btn.btn-primary', { type: 'button', onclick: () => ctx.go(`#/watch/${lastEp.id}`) },
        icon('play'), '继续'),
    );
    page.appendChild(cont);
  }

  /* 选集网格 */
  const grid = h('div.ep-grid');
  episodes.forEach((ep) => {
    grid.appendChild(episodeCard(ep, (e) => ctx.go(`#/watch/${e.id}`)));
  });
  page.appendChild(grid);

  /* 页脚说明 */
  const mounted = episodes.filter((e) => e.source === 'mounted').length;
  const imported = episodes.filter((e) => e.source === 'imported').length;
  page.appendChild(h('p', {
    style: { margin: '4px 0 0', fontSize: '12.5px', color: 'var(--ink-3)', lineHeight: '1.6' },
  }, `共 ${episodes.length} 集 · 本地挂载 ${mounted} 集 · 浏览器导入 ${imported} 集。`
    + '字幕由语音识别自动生成并已按时序整理，逐句核对后可标记为「已校对」。'));

  host.appendChild(page);
}
