/* 应用入口：路由 + 顶部栏 + 启动自检 */

import { h, clear, append, icon, toast, bus } from './util.js';
import { loadCatalog, invalidateCatalog, releaseBlobUrls } from './content.js';
import { getPrefs, setPrefs, storageAvailable } from './store.js';
import { renderLibrary } from './library.js';
import { renderWorkbench } from './workbench.js';
import { renderImport } from './importer.js';

const root = document.getElementById('app');
let cleanupCurrent = null;

/* -------------------------------------------------------------- 顶部栏

   播放页的顶栏可以整条收起（点击顶栏空白处或右侧按钮），把高度让给播放器。
   收起后屏幕上只留一个左上角的小胶囊用于唤回 —— 否则顶栏没了就再也回不来。
   状态存在偏好里，但**只**在播放页生效：选集页／整理页始终显示顶栏，
   不然连「选集」入口都找不到。 */

const TB = { bar: null, peek: null, btn: null, hidden: false };

/** 把顶栏的实际高度写进 --topbar-h，CSS 用它换算「让出多少给播放器」 */
function measureTopbar() {
  if (!TB.bar) return;
  const hh = Math.round(TB.bar.getBoundingClientRect().height);
  if (hh > 0) document.documentElement.style.setProperty('--topbar-h', `${hh}px`);
}

function paintTopbar() {
  document.documentElement.classList.toggle('topbar-hidden', TB.hidden);
  if (TB.peek) TB.peek.hidden = !TB.hidden;
  if (TB.btn) {
    clear(TB.btn);
    TB.btn.appendChild(icon(TB.hidden ? 'chevronDown' : 'chevronUp'));
    const label = TB.hidden ? '展开顶栏' : '收起顶栏';
    TB.btn.title = TB.hidden ? '展开顶栏' : '收起顶栏（把空间让给播放器）';
    TB.btn.setAttribute('aria-label', label);
    TB.btn.setAttribute('aria-expanded', String(!TB.hidden));
  }
}

function setTopbarHidden(hidden, { persist = true } = {}) {
  TB.hidden = !!hidden;
  if (persist) setPrefs({ topbarHidden: TB.hidden });
  paintTopbar();
}

let tbHintShown = false;

function toggleTopbar(force) {
  const next = typeof force === 'boolean' ? force : !TB.hidden;
  if (next && !tbHintShown) {
    tbHintShown = true;
    toast('顶栏已收起；点左上角的「顶栏」可以再展开（或按 T）', 3600);
  }
  setTopbarHidden(next);
}

/** 离开播放页：顶栏引用作废，并确保收起态不会带到别的页面 */
function teardownTopbar() {
  TB.bar = null; TB.peek = null; TB.btn = null; TB.hidden = false;
  document.documentElement.classList.remove('topbar-hidden');
}

/* 播放页里按 T 也能收起/展开顶栏（与 r/c/b 快捷键保持一致） */
bus.addEventListener('topbar:toggle', () => { if (TB.bar) toggleTopbar(); });

window.addEventListener('resize', () => { if (TB.bar && !TB.hidden) measureTopbar(); });
window.addEventListener('orientationchange', () => {
  // 旋转时安全区会变（竖屏有刘海），等布局稳定再量一次
  setTimeout(() => { if (TB.bar && !TB.hidden) measureTopbar(); }, 260);
});

function brandMark() {
  const span = h('span.brand-mark');
  span.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 9l17.3 10v20L32 49 14.7 39V19z" fill="#2E7D5B" opacity=".16"/>
    <path d="M32 9l17.3 10v20L32 49 14.7 39V19z" fill="none" stroke="#2F7D5B" stroke-width="3.4" stroke-linejoin="round"/>
    <circle cx="32" cy="29" r="7.4" fill="none" stroke="#2F7D5B" stroke-width="3.4"/>
    <path d="M22 52c6-5 14-5 20 0" fill="none" stroke="#B4692A" stroke-width="3.4" stroke-linecap="round"/>
  </svg>`;
  return span;
}

function topbar({ contextSeries, contextTitle, contextNo, actions, collapsible = false }) {
  const bar = h('header.topbar');
  const brand = h('a.brand', { href: '#/library' },
    brandMark(),
    h('span.brand-text',
      h('span.brand-title', '螺丝钉英语磨耳朵'),
      h('span.brand-sub', '听力工作台'),
    ),
  );
  bar.appendChild(brand);
  if (contextTitle) {
    bar.appendChild(h('div.topbar-context',
      contextSeries ? h('span.topbar-series', contextSeries) : null,
      contextNo ? h('span.topbar-ep-no', contextNo) : null,
      h('span.topbar-ep-title', contextTitle),
    ));
  } else {
    bar.appendChild(h('div', { style: { flex: '1 1 auto' } }));
  }
  const acts = h('div.topbar-actions');
  append(acts, actions || []);
  if (collapsible) {
    bar.classList.add('topbar-collapsible');
    acts.appendChild(h('button.btn.btn-ghost.btn-icon.topbar-toggle', {
      type: 'button',
      title: '收起顶栏（把空间让给播放器）',
      'aria-label': '收起顶栏',
      onclick: (e) => { e.stopPropagation(); toggleTopbar(); },
    }, icon('chevronUp')));
    // 顶栏空白处也可点：链接/按钮保留各自语义，不抢它们的点击
    bar.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      toggleTopbar();
    });
  }
  bar.appendChild(acts);
  return bar;
}

/** 顶栏收起后留在左上角的小胶囊：唯一能把顶栏唤回来的入口 */
function topbarPeek() {
  return h('button.topbar-peek', {
    type: 'button', hidden: true,
    title: '展开顶栏', 'aria-label': '展开顶栏',
    onclick: () => setTopbarHidden(false),
  }, icon('chevronDown'), h('span.topbar-peek-text', '顶栏'));
}


/* -------------------------------------------------------------- 路由 */

function parseRoute() {
  const raw = (location.hash || '#/library').replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'library', arg: rest.join('/') || null };
}

async function render() {
  if (cleanupCurrent) { try { cleanupCurrent(); } catch {} cleanupCurrent = null; }
  releaseBlobUrls();

  const route = parseRoute();
  clear(root);
  teardownTopbar();   // 收起态只属于播放页，换页一律先复位
  // 工作台整页锁定高度，让字幕栏与舞台各自内部滚动（其余页面正常文档流滚动）
  document.documentElement.classList.toggle('wb-lock', route.name === 'watch');

  /* file:// 直接打开时 fetch 会失败，先给出明确指引 */
  if (location.protocol === 'file:') {
    root.appendChild(topbar({ actions: [] }));
    root.appendChild(h('div.page',
      h('div.empty',
        h('div.empty-mark', icon('alert')),
        h('h2', '需要用本地服务器打开'),
        h('p', '浏览器不允许 file:// 页面读取同目录的视频和字幕。请在项目目录执行下面的命令，再用 Safari 访问提示的地址。'),
        h('div.veil-hint', { style: { color: 'var(--ink-2)', background: 'var(--surface-sunk)', borderColor: 'var(--line)' } },
          './serve.sh\n# 或\npython3 -m http.server 8765 --bind 0.0.0.0'),
      ),
    ));
    return;
  }

  if (!storageAvailable()) {
    toast('浏览器存储不可用（可能是无痕模式），进度与偏好无法保存');
  }

  if (route.name === 'import') {
    const catalog = await loadCatalog();
    root.appendChild(topbar({
      actions: [h('a.btn', { href: '#/library' }, icon('back'), '回到选集')],
    }));
    const main = h('div', { style: { display: 'contents' } });
    root.appendChild(main);
    await renderImport(main, ctx);
    return;
  }

  const catalog = await loadCatalog();

  if (route.name === 'watch' && route.arg) {
    const ep = catalog.episodes.find((e) => e.id === route.arg);
    if (!ep) {
      root.appendChild(topbar({ actions: [] }));
      root.appendChild(h('div.page', h('div.empty',
        h('div.empty-mark', icon('alert')),
        h('h2', '找不到这一集'),
        h('p', '内容清单里没有这个编号，可能清单已更新。'),
        h('a.btn.btn-primary', { href: '#/library' }, '回到选集'),
      )));
      return;
    }
    root.appendChild(topbar({
      contextSeries: ep.seriesMeta ? ep.seriesMeta.title : null,
      contextNo: `第 ${String(ep.order).padStart(2, '0')} 集`,
      contextTitle: ep.title,
      actions: [h('a.btn', { href: '#/library' }, icon('library'), '选集')],
      collapsible: true,
    }));
    // 顶栏收起的整套状态：先按「展开态」量高度，再应用上次的偏好
    TB.bar = root.querySelector('.topbar');
    TB.btn = root.querySelector('.topbar-toggle');
    TB.peek = topbarPeek();
    root.appendChild(TB.peek);
    TB.hidden = !!getPrefs().topbarHidden;
    measureTopbar();
    paintTopbar();
    const main = h('div', { style: { display: 'contents' } });
    root.appendChild(main);
    cleanupCurrent = await renderWorkbench(main, ep);
    return;
  }

  root.appendChild(topbar({
    actions: [h('a.btn', { href: '#/import' }, icon('folder'), '内容整理')],
  }));
  const main = h('div', { style: { display: 'contents' } });
  root.appendChild(main);
  renderLibrary(main, catalog, ctx);
}

/* -------------------------------------------------------------- 上下文 */

const ctx = {
  go(hash) { if (location.hash === hash) render(); else location.hash = hash; },
  async catalog() { return loadCatalog(); },
  async reload() { invalidateCatalog(); await render(); },
};

window.addEventListener('hashchange', render);

/* 启动 */
const prefs = getPrefs();
document.body.classList.toggle('hide-zh', !prefs.showChineseHint);
if (!location.hash) location.hash = '#/library';
render();
