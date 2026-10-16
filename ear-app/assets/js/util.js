/* 通用工具：DOM 构建、时间格式化、图标、Toast */

/** 极简 hyperscript：h('div.card#id', {attrs}, ...children) */
export function h(sel, props, ...kids) {
  let tag = 'div', id = null;
  const classes = [];
  const m = String(sel).match(/^([a-zA-Z][\w-]*)?((?:[.#][^.#]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    const rest = m[2] || '';
    for (const tok of rest.match(/[.#][^.#]+/g) || []) {
      if (tok[0] === '.') classes.push(tok.slice(1));
      else id = tok.slice(1);
    }
  }
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;
  if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) {
    kids.unshift(props); props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

/** 支持 append(el, a, b, c) 与 append(el, [a, b]) 两种写法 */
export function append(el, ...kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === true) continue;
    if (Array.isArray(k)) append(el, ...k);
    else el.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/** 秒 → 00:00 / 0:00:00（用于长视频） */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const mi = Math.floor(sec / 60) % 60;
  const hr = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return hr > 0 ? `${hr}:${p(mi)}:${p(s)}` : `${mi}:${p(s)}`;
}

/** 秒 → 00:00.0（字幕表用的弱化时间标签） */
export function fmtShort(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const mi = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

const ICONS = {
  play:      '<path d="M8 5.14v13.72a1 1 0 001.54.84l10.7-6.86a1 1 0 000-1.68L9.54 4.3A1 1 0 008 5.14z"/>',
  pause:     '<path d="M7 4.5h3.4v15H7zM13.6 4.5H17v15h-3.4z"/>',
  replay:    '<path d="M12 5V2L7 6l5 4V7a5 5 0 11-5 5H5a7 7 0 107-7z"/>',
  back:      '<path d="M15.4 5.6L13.99 4.19 7.18 11l6.81 6.81 1.41-1.41L10 11z"/>',
  forward:   '<path d="M8.6 5.6L10.01 4.19 16.82 11l-6.81 6.81-1.41-1.41L14 11z"/>',
  library:   '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  folder:    '<path d="M3.5 6.5A2 2 0 015.5 4.5h3.2l1.6 2H18.5a2 2 0 012 2v7a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  check:     '<path d="M9.55 17.6l-5.3-5.3 1.9-1.9 3.4 3.4 8.3-8.3 1.9 1.9z"/>',
  alert:     '<path d="M12 2.6l9.5 16.4H2.5zM11 9.5v4.6h2V9.5zm0 5.9v2h2v-2z"/>',
  info:      '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
  chinese:   '<path d="M4 5h9v2H9.4v2H13v2H9.7c.5 1.2 1.4 2.2 2.6 2.9l-1.2 1.6A9.3 9.3 0 018 13.4 10 10 0 015.9 16L4.5 14.5A8.6 8.6 0 006.7 12H4.6V10h3V7H4zM15 8h2l3.5 11h-2.1l-.8-2.7h-3.2L13.6 19h-2.1zm.4 6.5h2.2L16.5 10z"/>',
  follow:    '<path d="M12 4l6 6h-4v6h-4v-6H6z"/>',
  eyeOff:    '<path d="M2.1 3.5l18.4 18.4-1.4 1.4-3.5-3.5A11 11 0 0112 20C6 20 2 12 2 12a19 19 0 015-6.2L3.5 4.9zM12 4c6 0 10 8 10 8a19 19 0 01-3.1 4.4L13.4 11a2 2 0 00-2.5-2.5L7.6 5.2A11 11 0 0112 4z"/>',
  eye:       '<path d="M12 5c6 0 10 7 10 7s-4 7-10 7S2 12 2 12s4-7 10-7zm0 3a4 4 0 100 8 4 4 0 000-8z"/>',
  download:  '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16 6.3 11.3l1.4-1.4L11 12.2zM5 18h14v2H5z"/>',
  trash:     '<path d="M9 3h6l.7 2H19v2H5V5h3.3zM6.5 8h11l-.8 12a1.5 1.5 0 01-1.5 1.4H8.8A1.5 1.5 0 017.3 20z"/>',
  wifi:      '<path d="M12 18.5a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM12 12.6c1.8 0 3.5.7 4.8 1.9l1.6-1.7A9.6 9.6 0 0012 10.2c-2.5 0-4.8 1-6.4 2.6l1.6 1.7A7 7 0 0112 12.6zm0-6.3c3.5 0 6.7 1.3 9.1 3.5l1.6-1.7A14.5 14.5 0 0012 4.2c-4.1 0-7.8 1.5-10.7 4l1.6 1.7A12.6 12.6 0 0112 6.3z"/>',
  spinner:   '<path d="M12 3a9 9 0 019 9h-2.4A6.6 6.6 0 0012 5.4z"/>',
  mic:       '<path d="M12 14.5a3.5 3.5 0 003.5-3.5V6a3.5 3.5 0 10-7 0v5a3.5 3.5 0 003.5 3.5zM17.5 11a5.5 5.5 0 01-11 0H4.8a7.2 7.2 0 006.2 7.1V21h2v-2.9a7.2 7.2 0 006.2-7.1z"/>',
  ear:       '<path d="M12 3a6.5 6.5 0 00-6.5 6.5h2A4.5 4.5 0 0112 5a4.5 4.5 0 014.5 4.5c0 1.7-.8 2.6-1.9 3.6-1.2 1.1-2.6 2.4-2.6 4.9a2 2 0 01-2 2 2 2 0 01-2-2H6a4 4 0 008 0c0-1.5.7-2.3 1.8-3.3 1.2-1.1 2.7-2.5 2.7-5.2A6.5 6.5 0 0012 3z"/>',
  chevronDown: '<path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>',
  chevronUp:   '<path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>',
};

export function icon(name, cls) {
  const p = ICONS[name] || ICONS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'currentColor');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = p;
  return svg;
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => { el.dataset.show = '1'; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = '0';
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

/** 简易事件总线：跨页面通信（导入完成、偏好变更…） */
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 稳定的每集配色（无缩略图时用） */
export function tintFor(id) {
  let n = 0;
  for (let i = 0; i < String(id).length; i++) n = (n * 31 + String(id).charCodeAt(i)) >>> 0;
  const hues = [ [47,125,91], [43,108,147], [180,105,42], [96,110,60], [124,84,150] ];
  const [r, g, b] = hues[n % hues.length];
  const deg = (n % 12) * 3;
  return `linear-gradient(${135 + deg}deg, rgba(${r},${g},${b},.16), rgba(${r},${g},${b},.05))`;
}
