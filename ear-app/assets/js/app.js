/* 应用入口：路由 + 顶部栏 + 启动自检 */

import { h, clear, append, icon, toast } from './util.js';
import { loadCatalog, invalidateCatalog, releaseBlobUrls } from './content.js';
import { getPrefs, storageAvailable } from './store.js';
import { renderLibrary } from './library.js';
import { renderWorkbench } from './workbench.js';
import { renderImport } from './importer.js';

const root = document.getElementById('app');
let cleanupCurrent = null;

/* -------------------------------------------------------------- 顶部栏 */

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

function topbar({ contextSeries, contextTitle, contextNo, actions }) {
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
  bar.appendChild(acts);
  return bar;
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
    }));
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
