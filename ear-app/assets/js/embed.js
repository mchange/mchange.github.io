/* 外链播放页：B 站官方 iframe 播放器。

   为什么不用 <video src>：B 站的直链是带签名的 CDN URL，会过期、会校验 Referer，
   不能长期挂在目录里。官方外链播放器是唯一稳定且合规的入口。

   硬性约束（踩过坑，勿回退）：
   1. iframe 必须带 sandbox="allow-scripts allow-same-origin"，但**不能**给
      allow-top-navigation / allow-popups。实测播放器里的「进入哔哩哔哩，观看更高清」
      按钮会在这种 sandbox 下被拦住，顶层页面和浏览器标签都不会跳走。
   2. 不给这一页接自有字幕/闪卡/进度条：播放控制权在 B 站播放器里，
      我们要的只是「在我们自己的选集壳里展示」。
*/

import { h, clear, icon, epNoLabel, emit } from './util.js';
import { loadCatalog } from './content.js';

function embedSrc(ep) {
  const raw = ep.video || `https://player.bilibili.com/player.html?bvid=${ep.bvid}&page=1`;
  const u = new URL(raw, location.href);
  // 目录改了 order / bvid 时，以目录字段为准，避免 iframe 还停在旧分集
  u.searchParams.set('page', String(ep.embedPage || ep.order || 1));
  u.searchParams.set('autoplay', '0');
  u.searchParams.set('danmaku', '0');
  u.searchParams.set('as_wide', '1');
  return u.href;
}

export async function renderEmbedWorkbench(host, ep, ctx) {
  clear(host);

  const catalog = await loadCatalog();
  const list = catalog.episodes.filter((x) => x.series === ep.series);
  const idx = Math.max(0, list.findIndex((x) => x.id === ep.id));
  const prev = list[idx - 1] || null;
  const next = list[idx + 1] || null;

  const go = (target) => {
    if (!target) return;
    const hash = `#/watch/${target.id}`;
    if (ctx && typeof ctx.go === 'function') ctx.go(hash);
    else location.hash = hash;
  };

  /* ---------- 播放器：外链 iframe ---------- */
  const frame = h('iframe.embed-frame', {
    id: 'bili-embed',
    src: embedSrc(ep),
    title: `${epNoLabel(ep)} ${ep.title}`,
    sandbox: 'allow-scripts allow-same-origin',
    allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
    allowfullscreen: true,
    referrerpolicy: 'no-referrer',
    loading: 'eager',
  });
  const player = h('div.player.embed-player', frame);

  const navBtn = (target, label, ico) => h('button.btn.btn-ghost', {
    type: 'button',
    disabled: !target,
    'aria-label': label,
    onclick: () => go(target),
  }, icon(ico), label);

  const head = h('div.embed-nav',
    navBtn(prev, '上一集', 'back'),
    h('div.embed-nav-title',
      h('span.embed-kicker', ep.seriesMeta ? ep.seriesMeta.title : '外链播放'),
      h('h2', `${epNoLabel(ep)} · ${ep.title}`),
    ),
    navBtn(next, '下一集', 'forward'),
  );

  const note = h('p.embed-note', icon('link'),
    '视频由 B 站官方播放器加载，画面里的中英文字幕由 B 站提供；' +
    '本项目不保存视频文件，观看需要联网。');

  /* ---------- 右侧：同合集分集，便于连续听 ---------- */
  const side = h('aside.side-panel.embed-side',
    h('div.embed-side-head', `分集 · ${list.length}`),
  );
  const listBox = h('div.embed-list');
  list.forEach((item) => {
    const b = h('button.embed-item', {
      type: 'button',
      'data-id': item.id,
      'aria-current': String(item.id === ep.id),
      onclick: () => go(item),
    },
      h('span.embed-item-no', String(item.order || 0).padStart(2, '0')),
      h('span.embed-item-title', item.title),
    );
    if (item.id === ep.id) b.classList.add('is-active');
    listBox.appendChild(b);
  });
  side.appendChild(listBox);

  const wb = h('div.wb.wb-embed',
    h('div.wb-body',
      h('div.wb-stage', head, player, note),
      side,
    ),
  );
  host.appendChild(wb);

  /* 与工作台保持一致：T 收顶栏；左右方向键切集。 */
  const onKey = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 't' || e.key === 'T') {
      emit('topbar:toggle');
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && prev) {
      go(prev); e.preventDefault();
    } else if (e.key === 'ArrowRight' && next) {
      go(next); e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey);
  const active = side.querySelector('.embed-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });

  return () => window.removeEventListener('keydown', onKey);
}
