/* 页面 2 · 动画学习工作台（核心页）
 *
 * 规则对应方案 §4：
 *   4.1 连续模式：字幕随播放高亮、点击定位、手动滚动时暂停强制跟随
 *   4.2 单句模式：到句尾暂停、再听一次、上一句/下一句、未校对句不作为可靠目标
 *   4.3 速度与模式切换：不重置播放位置，媒体状态以真实 video 事件为准
 *   4.4 字幕匹配：同一时刻只允许一个当前句（重叠取最近开始的一条）
 */

import {
  h, clear, append, icon, fmtTime, fmtShort, toast, clamp, emit,
} from './util.js';
import {
  getPrefs, setPrefs, getProgress, saveProgress, RATES, GAP_CHOICES,
  SUBTITLE_MODES, SUBTITLE_LABELS, SIDE_TABS, END_MODES,
  bumpPass, getPasses, isCardKnown, setCardKnown, resetCards,
} from './store.js';
import { loadLines, loadWords, videoSources, loadCatalog } from './content.js';
import { isCached, cacheEpisode, fmtMB } from './cache.js';

/* 右侧面板的两个页签：[键, 标签, 图标] */
const TAB_DEFS = [['subs', '字幕', 'chinese'], ['cards', '闪卡', 'library']];

/* 一集播完后的三种走向：[键, 按钮文字, 说明] */
const END_DEFS = [
  ['loop', '循环本集', '播完自动从头再听一遍（磨耳朵默认）'],
  ['across', '连播下一集', '播完自动接着听下一集'],
  ['stop', '播完即停', '播完就停下，不自动继续'],
];

/* 控制条的显示方式：[键, 按钮文字, 说明] */
const CHROME_DEFS = [
  ['show', '一直显示', '进度条和控制条始终留在画面上'],
  ['auto', '自动隐藏', '播放 2.6 秒后收起，点一下画面再唤回（画面更大）'],
];

export async function renderWorkbench(host, ep) {
  const lines = await loadLines(ep);
  const [sources, words] = await Promise.all([videoSources(ep), loadWords(ep)]);
  const prefs = getPrefs();

  const S = {
    lines,
    activeIndex: -1,
    selectedIndex: null,
    mode: prefs.mode,
    rate: prefs.rate,
    subMode: SUBTITLE_MODES.includes(prefs.subtitleMode) ? prefs.subtitleMode : 'both',
    sideTab: SIDE_TABS.includes(prefs.sideTab) ? prefs.sideTab : 'subs',
    blind: !!prefs.blindFirst,
    gapSec: prefs.gapSeconds || 3,
    endMode: END_MODES.includes(prefs.endMode) ? prefs.endMode : 'loop',
    autoHide: !!prefs.autoHideChrome,
    keepAwake: prefs.keepAwake !== false,
    cacheMode: prefs.videoCache === 'auto',
    cached: false,            // 这一集是否已在本机（决定缓存 chip 与是否要下载）
    gapLeft: 0,
    gapTimer: 0,
    passCounted: false,
    follow: true,
    seekAt: 0,
    srcIndex: 0,
    playState: 'paused',
    lastSavedAt: 0,
    rafId: 0,
  };

  let video, scrubEl, scrubFill, scrubKnob, scrubBuffer, timeNow, timeTotal,
      playBtn, modeSeg, rateSeg, subSeg, blindBtn, gapSeg, endSeg, chromeSeg,
      bufSpinner, cacheChip, wakeChip,
      subLayer, subEn, subZh, gapChip, gapText, gapBar, veil, veilTitle,
      veilMsg, veilHint, scrollEl, rowsEl, rowEls = [], followChip, resumeBar,
      markLayer, warningChip, headStatus, fcCount, fcRow, sidePanel;

  /* ------------------------------------------------------------ 构建 DOM */

  video = h('video', { playsinline: true, 'webkit-playsinline': '', preload: 'metadata' });
  video.setAttribute('x-webkit-airplay', 'deny');

  scrubBuffer = h('div.scrub-buffer');
  scrubFill = h('div.scrub-fill');
  scrubKnob = h('div.scrub-knob');
  markLayer = h('div.scrub-marks');
  scrubEl = h('div.scrub', {
    role: 'slider', tabindex: '0', 'aria-label': '播放进度',
    'aria-valuemin': '0', 'aria-valuenow': '0',
  }, h('div.scrub-track', scrubBuffer, scrubFill), markLayer, scrubKnob);

  timeNow = h('span.time-now', '0:00');
  timeTotal = h('span.time-total', '--:--');
  playBtn = h('button.btn.btn-play', { type: 'button', 'aria-label': '播放' }, icon('play'));

  veilTitle = h('h3', '视频无法读取');
  veilMsg = h('p', '');
  veilHint = h('div.veil-hint');
  veil = h('div.player-veil', { hidden: true },
    h('div.veil-inner', icon('alert'), veilTitle, veilMsg, veilHint));

  /* 播放器内字幕层：随播放显示当前句，关 / 中 / 英 / 中英 四态可切 */
  subEn = h('p.sub-en', '');
  subZh = h('p.sub-zh', '');
  subLayer = h('div.sub-layer', { dataset: { mode: S.subMode, active: '0' } },
    h('div.sub-inner', subEn, subZh));

  /* 跟读留白提示：挂在播放器顶部，替代原来压在字幕卡里的位置 */
  gapText = h('span.gap-text', '跟读一遍');
  gapBar = h('div.gap-bar-fill');
  gapChip = h('div.gap-chip', { hidden: true },
    h('span.gap-icon', icon('mic')), gapText, h('div.gap-bar', gapBar));

  /* 缓冲指示：iPad 上 seek 要等 Range 回来，没有指示会以为按坏了 */
  bufSpinner = h('div.buf-spinner', { hidden: true },
    h('span.buf-ring'), h('span.buf-text', '缓冲中…'));
  /* 状态角标：屏幕常亮 / 本机缓存 / 缓存进度 */
  wakeChip = h('div.pchip.pchip-wake', { hidden: true }, '屏幕常亮');
  cacheChip = h('div.pchip.pchip-cache', { hidden: true });
  const playerBadges = h('div.player-badges', wakeChip, cacheChip);

  const player = h('div.player', video, subLayer, gapChip, bufSpinner, playerBadges, veil);

  modeSeg = h('div.seg', { role: 'group', 'aria-label': '播放模式' });
  const modeBtns = [['continuous', '连续'], ['single', '单句'], ['shadow', '跟读']]
    .map(([m, label]) => {
      const b = h('button', {
        type: 'button', 'aria-pressed': String(S.mode === m),
        onclick: () => setMode(m),
      }, label);
      b.dataset.mode = m;
      modeSeg.appendChild(b);
      return b;
    });

  gapSeg = h('div.seg.seg-gap', { role: 'group', 'aria-label': '跟读间隔' });
  const gapBtns = GAP_CHOICES.map((g) => {
    const b = h('button', {
      type: 'button', 'aria-pressed': String(S.gapSec === g),
      onclick: () => setGap(g),
    }, `${g}秒`);
    b.dataset.gap = String(g);
    gapSeg.appendChild(b);
    return b;
  });

  /* 一集播完后的走向：循环本集（默认）/ 连播下一集 / 播完即停 */
  endSeg = h('div.seg.seg-end', { role: 'group', 'aria-label': '本集播完后' });
  const endBtns = END_DEFS.map(([m, label, tip]) => {
    const b = h('button', {
      type: 'button', 'aria-pressed': String(S.endMode === m),
      title: tip, onclick: () => setEndMode(m),
    }, label);
    b.dataset.end = m;
    endSeg.appendChild(b);
    return b;
  });

  rateSeg = h('div.seg', { role: 'group', 'aria-label': '播放速度' });
  const rateBtns = RATES.map((r) => {
    const b = h('button', {
      type: 'button', 'aria-pressed': String(S.rate === r),
      onclick: () => setRate(r),
    }, r === 1.0 ? '1.0×' : `${r}×`);
    b.dataset.rate = String(r);
    rateSeg.appendChild(b);
    return b;
  });

  subSeg = h('div.seg.seg-sub', { role: 'group', 'aria-label': '播放器字幕' });
  const subBtns = SUBTITLE_MODES.map((m) => {
    const b = h('button', {
      type: 'button',
      'aria-pressed': String(S.subMode === m),
      title: { off: '不显示字幕', zh: '只显示中文', en: '只显示英文', both: '中英文一起显示' }[m],
      onclick: () => setSubMode(m),
    }, SUBTITLE_LABELS[m]);
    b.dataset.sub = m;
    subSeg.appendChild(b);
    return b;
  });

  /* 进度条/控制条要不要在播放时自动收起（默认一直显示） */
  chromeSeg = h('div.seg.seg-chrome', { role: 'group', 'aria-label': '控制条显示方式' });
  const chromeBtns = CHROME_DEFS.map(([m, label, tip]) => {
    const b = h('button', {
      type: 'button',
      'aria-pressed': String((m === 'auto') === S.autoHide),
      title: tip, onclick: () => setChromeMode(m),
    }, label);
    b.dataset.chrome = m;
    chromeSeg.appendChild(b);
    return b;
  });

  const prevBtn = h('button.btn', { type: 'button', onclick: () => stepLine(-1) },
    icon('back'), '上一句');
  const replayBtn = h('button.btn', { type: 'button', onclick: () => replay() },
    icon('replay'), '再听一次');
  const nextBtn = h('button.btn', { type: 'button', onclick: () => stepLine(1) },
    '下一句', icon('forward'));

  blindBtn = h('button.btn', { type: 'button', onclick: toggleBlind });

  const controlsRow = h('div.controls-row',
    h('div.ctrl-group', h('span.field-label', '模式'), modeSeg, gapSeg),
    h('div.ctrl-group', h('span.field-label', '播完'), endSeg),
    h('div.ctrl-group', prevBtn, replayBtn, nextBtn),
    h('div.controls-spacer'),
    blindBtn,
    h('div.ctrl-group', h('span.field-label', '字幕'), subSeg),
    h('div.ctrl-group', h('span.field-label', '控制条'), chromeSeg),
    h('div.ctrl-group', h('span.field-label', '速度'), rateSeg),
  );

  const transport = h('div.transport', playBtn, timeNow, scrubEl, timeTotal);

  resumeBar = h('div.resume-bar', { hidden: true });

  /* ---- 右侧面板：闪卡 / 字幕表 两个页签，左侧专心留给播放器 ---- */
  fcCount = h('span.fc-count', '');
  fcRow = h('div.fc-row', { role: 'list' });
  const fcPane = h('div.side-pane.side-cards', { dataset: { pane: 'cards' } },
    h('div.fc-head',
      h('span.field-label', '本集单词与短语'),
      fcCount,
      h('button.btn.btn-ghost.fc-reset', {
        type: 'button',
        onclick: () => {
          words.forEach((w) => setCardKnown(ep.id, w.en, false));
          buildCards();
          toast('已清空这一集的认词记录');
        },
      }, '重新来')),
    words.length ? fcRow : h('p.side-empty', '这一集还没有整理单词卡'));

  const stageScroll = h('div.stage-scroll', player, transport, controlsRow, resumeBar);
  const stage = h('section.wb-stage', stageScroll);

  followChip = h('button.follow-chip', { type: 'button', title: '自动跟随当前句' }, icon('follow'));
  scrollEl = h('div.transcript-scroll');
  rowsEl = h('div.rows');
  scrollEl.appendChild(rowsEl);
  const transcriptCount = h('span.transcript-count', `${lines.length} 句`);
  warningChip = h('span');
  headStatus = h('span.badge.badge-pass', { hidden: true });
  const transcriptHead = h('div.transcript-head',
    h('span.field-label', '字幕表'), transcriptCount, headStatus, warningChip, followChip);
  const transcript = h('div.transcript.side-pane', { dataset: { pane: 'subs' } },
    transcriptHead, scrollEl);

  sidePanel = h('aside.side-panel', { dataset: { tab: S.sideTab } },
    h('div.side-tabs', { role: 'tablist', 'aria-label': '右侧面板' },
      ...TAB_DEFS.map(([key, label, tabIcon]) => {
        const b = h('button.side-tab', {
          type: 'button', role: 'tab', 'aria-selected': String(S.sideTab === key),
          onclick: () => setTab(key),
        }, icon(tabIcon), label);
        b.dataset.tab = key;
        return b;
      })),
    fcPane, transcript);

  const body = h('div.wb-body', stage, sidePanel);
  const wbRoot = h('div.wb', { dataset: { mode: S.mode } }, body);
  clear(host);
  host.appendChild(wbRoot);

  function setTab(key) {
    if (!SIDE_TABS.includes(key) || key === S.sideTab) return;
    S.sideTab = key;
    setPrefs({ sideTab: key });
    sidePanel.dataset.tab = key;
    sidePanel.querySelectorAll('.side-tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === key));
    });
    if (key === 'subs') autoScrollTo(S.activeIndex >= 0 ? S.activeIndex : (S.selectedIndex ?? 0));
  }

  /* ------------------------------------------------------------ 字幕行 */

  function buildRows() {
    clear(rowsEl);
    rowEls = [];
    if (!lines.length) {
      rowsEl.appendChild(h('div.transcript-empty',
        '这一集的字幕还没有整理好。', h('br'), '可以在「内容整理」里补充字幕后重试。'));
      return;
    }
    lines.forEach((L, i) => {
      const hasZh = !!String(L.zh || '').trim();
      const timeCell = h('span.trow-time', fmtShort(L.start));
      const enCell = h('span.trow-en', L.en);
      if (L.kind === 'title') enCell.appendChild(h('span.trow-flag', '集名'));
      if (!hasZh) enCell.appendChild(h('span.trow-flag', '无中文'));
      const main = h('span.trow-main', enCell,
        h('span.trow-zh', { dataset: { empty: hasZh ? '0' : '1' } },
          hasZh ? L.zh : '（本句暂无中文提示）'));
      const row = h('button.trow', {
        type: 'button',
        dataset: {
          index: String(i),
          kind: L.kind || '',
          draft: ep.subtitleStatus === 'verified' ? '0' : '1',
          revealed: '0',
        },
        'aria-label': `${fmtShort(L.start)} ${L.en}`,
        onclick: () => {
          row.dataset.revealed = '1';       // 盲听模式下：点哪句揭示哪句
          selectLine(i, { play: true });
        },
      }, timeCell, main);
      rowEls.push(row);
      rowsEl.appendChild(row);
    });
  }

  /* ------------------------------------------------------------ 基础状态 */

  function paintMarks() {
    clear(markLayer);
    const dur = mediaDuration();
    if (!dur) return;
    for (const L of lines) {
      const pct = clamp(L.start / dur, 0, 1) * 100;
      markLayer.appendChild(h('div.scrub-mark', { style: { left: `${pct}%` } }));
    }
  }

  function mediaDuration() {
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return ep.durationSeconds || 0;
  }

  function paintHeadStatus() {
    const n = getPasses(ep.id);
    headStatus.hidden = n <= 0;
    if (n <= 0) return;
    clear(headStatus);
    headStatus.appendChild(icon('ear'));
    headStatus.appendChild(document.createTextNode(`已听 ${n} 遍`));
    headStatus.title = '听到本集结尾就会记一遍';
  }

  /** 4.4 字幕匹配：同一时刻只取「最近开始的一条」，落在间隙则无当前句 */
  function findActiveIndex(t) {
    if (!lines.length) return -1;
    let lo = 0, hi = lines.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t + 1e-6) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return -1;
    return t <= lines[best].end + 0.06 ? best : -1;
  }

  function paint() {
    for (let i = 0; i < rowEls.length; i++) {
      const r = rowEls[i];
      const a = i === S.activeIndex ? '1' : '0';
      const s = i === S.selectedIndex ? '1' : '0';
      if (r.dataset.active !== a) r.dataset.active = a;
      if (r.dataset.selected !== s) r.dataset.selected = s;
    }
    paintOverlay();
  }

  /** 播放器内字幕：只显示当前句；句间空隙就空着（和真实字幕一样） */
  function paintOverlay() {
    const i = S.activeIndex;
    const L = i >= 0 ? lines[i] : null;
    subLayer.dataset.active = L ? '1' : '0';
    subEn.textContent = L ? L.en : '';
    const zh = L ? String(L.zh || '').trim() : '';
    subZh.textContent = zh;
    subZh.dataset.empty = zh ? '0' : '1';
    // 盲听模式：当前句还没被点开 → 遮住英文，逼耳朵工作
    const revealed = !!(L && rowEls[i] && rowEls[i].dataset.revealed === '1');
    subEn.dataset.blind = (S.blind && L && !revealed) ? '1' : '0';
  }

  function updateActive(t) {
    const idx = findActiveIndex(t);
    if (idx === S.activeIndex) return;
    S.activeIndex = idx;
    paint();
    if (idx >= 0) autoScrollTo(idx);
  }

  /* ------------------------------------------------------------ 滚动跟随 */

  let progScroll = false, progTimer = 0;
  function autoScrollTo(i) {
    if (!S.follow || i < 0 || !rowEls[i]) return;
    const row = rowEls[i];
    const target = row.offsetTop - (scrollEl.clientHeight - row.offsetHeight) / 2;
    progScroll = true;
    scrollEl.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    clearTimeout(progTimer);
    progTimer = setTimeout(() => { progScroll = false; }, 700);
  }

  function paintFollow() {
    followChip.dataset.off = S.follow ? '0' : '1';
    clear(followChip);
    followChip.appendChild(icon(S.follow ? 'follow' : 'eyeOff'));
    followChip.appendChild(document.createTextNode(S.follow ? '自动跟随' : '已暂停跟随'));
    followChip.title = S.follow ? '字幕会跟随当前句滚动' : '点击恢复自动跟随';
  }

  scrollEl.addEventListener('scroll', () => {
    if (progScroll) return;
    if (S.follow) { S.follow = false; paintFollow(); }
  }, { passive: true });

  followChip.addEventListener('click', () => {
    S.follow = true;
    paintFollow();
    autoScrollTo(S.activeIndex >= 0 ? S.activeIndex : (S.selectedIndex ?? 0));
    toast('已恢复自动跟随');
  });

  /* ------------------------------------------------------------ 播放控制 */

  async function tryLoadSource() {
    if (!sources.length) {
      showVeil('这一集还没有可用视频', '挂载目录里找不到对应的 mp4 文件。', '');
      return;
    }
    video.src = sources[S.srcIndex];
    video.load();
  }

  function showVeil(title, msg, hint) {
    veilTitle.textContent = title;
    veilMsg.textContent = msg;
    veilHint.textContent = hint || '';
    veilHint.hidden = !hint;
    veil.hidden = false;
  }
  function hideVeil() { veil.hidden = true; }

  video.addEventListener('loadedmetadata', () => {
    hideVeil();
    paintMarks();
    const d = video.duration;
    if (Number.isFinite(d)) {
      timeTotal.textContent = fmtTime(d);
      scrubEl.setAttribute('aria-valuemax', String(Math.round(d)));
      // 内容校验（方案 §5.3）：字幕时间点不得越过视频时长
      const last = lines.length ? lines[lines.length - 1] : null;
      if (last && last.end > d + 0.5) {
        clear(warningChip);
        warningChip.appendChild(h('span.badge.badge-amber', icon('alert'), '末尾字幕超出时长'));
      }
    } else {
      timeTotal.textContent = ep.durationSeconds ? fmtTime(ep.durationSeconds) : '--:--';
    }
    applyRate();
    if (!S.restored) { S.restored = true; restoreProgress(); }
    paint();
  });

  video.addEventListener('error', () => {
    const more = S.srcIndex + 1 < sources.length;
    if (more) {
      S.srcIndex += 1;
      toast('当前文件无法播放，正在切换备用版本…');
      tryLoadSource();
      return;
    }
    const code = video.error ? video.error.code : 0;
    const reasons = {
      1: '播放被中止。',
      2: '读取视频文件时发生网络错误。',
      3: '视频解码失败。',
      4: '浏览器不支持这个视频格式或编码。',
    };
    showVeil(
      '这段视频无法播放',
      reasons[code] || '未知的媒体错误。',
      `当前地址：${video.currentSrc || '(空)'}\n错误码：${code || '无'}`,
    );
  });

  video.addEventListener('play', () => {
    S.playState = 'playing';
    clear(playBtn); playBtn.appendChild(icon('pause'));
    playBtn.setAttribute('aria-label', '暂停');
    clearGap();     // 用户主动播放 = 留白结束
    scheduleChromeHide();
    acquireWake();  // 播放 = 别锁屏
    // 播放稳定后再补缓存，别和首屏缓冲抢带宽
    if (!cacheStarted) {
      cacheStarted = true;
      setTimeout(() => { startCache(); }, 2500);
    }
  });
  video.addEventListener('pause', () => {
    S.playState = 'paused';
    clear(playBtn); playBtn.appendChild(icon('play'));
    playBtn.setAttribute('aria-label', '播放');
    showChrome();
    scheduleWakeRelease();   // 短暂暂停仍保持常亮，久无动静才放开
    saveNow();
  });
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime || 0;
    updateActive(t);
    timeNow.textContent = fmtTime(t);
    scrubFill.style.width = `${(mediaDuration() ? (t / mediaDuration()) * 100 : 0)}%`;
    scrubKnob.style.left = `${(mediaDuration() ? (t / mediaDuration()) * 100 : 0)}%`;
    scrubEl.setAttribute('aria-valuenow', String(Math.round(t)));
    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      scrubBuffer.style.width = `${(mediaDuration() ? (end / mediaDuration()) * 100 : 0)}%`;
    }
    if (Date.now() - S.lastSavedAt > 5000) saveNow();
    // 听到本集结尾 → 记一遍（磨耳朵靠的是重复遍数）
    const dur = mediaDuration();
    if (S.passCounted && t < 3) S.passCounted = false;   // 绕回开头＝新的一遍
    if (!S.passCounted && dur && t >= dur - 3) {
      S.passCounted = true;
      bumpPass(ep.id);
      paintHeadStatus();
    }
    // 单句模式：后台标签页里 rAF 会停，这里兜底检测句尾
    checkSentenceEnd();
  });
  video.addEventListener('seeking', () => { S.seekAt = performance.now(); });
  video.addEventListener('ratechange', () => { video.playbackRate = S.rate; });

  function playPause() {
    if (video.paused) {
      if (S.mode === 'single' && S.selectedIndex != null && lines[S.selectedIndex]) {
        const L = lines[S.selectedIndex];
        // 句尾再次点击播放 → 从本句开头重来，避免「一按就停」
        if (video.currentTime >= L.end - 0.05 || video.currentTime < L.start - 0.05) {
          video.currentTime = L.start;
          S.seekAt = performance.now();
        }
      }
      video.play().catch((err) => {
        const reason = video.error ? '媒体错误' : '浏览器拒绝了播放请求';
        showVeil('无法开始播放', `${reason}：${err && err.message ? err.message : ''}`,
          '请确认已使用 Safari 打开，并且视频文件可访问。');
      });
    } else {
      video.pause();
    }
  }

  playBtn.addEventListener('click', playPause);

  /* 播放时自动收起进度条和控制条，把画面让出来；点画面 / 暂停即唤回。
     默认「一直显示」——小孩子自己找得到按钮比多那一点画面重要，
     需要更大画面时在「控制条」里切到「自动隐藏」。 */
  let chromeTimer = 0;
  let chromeHintShown = false;
  function chromeVisible() { return !wbRoot.classList.contains('chrome-hidden'); }
  function setChrome(visible) {
    wbRoot.classList.toggle('chrome-hidden', !visible);
  }
  function scheduleChromeHide() {
    clearTimeout(chromeTimer);
    if (!S.autoHide) return;          // 开关关着就永不收起
    chromeTimer = setTimeout(() => {
      if (S.playState === 'playing' && !scrubbing && !chromeVisible()) return;
      if (S.playState === 'playing' && !scrubbing) {
        setChrome(false);
        if (!chromeHintShown) {
          chromeHintShown = true;
          toast('点一下画面，可以调出进度条和控制按钮');
        }
      }
    }, 2600);
  }
  function showChrome() {
    clearTimeout(chromeTimer);
    setChrome(true);
    if (S.playState === 'playing') scheduleChromeHide();  // 开了自动隐藏才会再收
  }

  function setChromeMode(m) {
    const auto = m === 'auto';
    if (auto === S.autoHide) return;
    S.autoHide = auto;
    setPrefs({ autoHideChrome: auto });
    chromeBtns.forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.chrome === 'auto') === auto));
    });
    if (auto) {
      toast('播放时 2.6 秒后自动收起控制条，点画面唤回');
      scheduleChromeHide();          // 正在播的话立刻开始计时
    } else {
      toast('控制条会一直显示');
      showChrome();
    }
  }
  stageScroll.addEventListener('pointerdown', () => {
    if (chromeVisible()) scheduleChromeHide();
    else showChrome();          // 第一击只负责唤回，不触发下层按钮的误触
  });
  stageScroll.addEventListener('pointermove', () => {
    if (chromeVisible()) scheduleChromeHide();
  }, { passive: true });
  stageScroll.addEventListener('keydown', showChrome);

  /* ------------------------------------------------ 屏幕常亮：播放期间不锁屏
   *
   * ⚠️ Screen Wake Lock 只在**安全上下文**里存在（HTTPS 或 localhost）。
   *    用局域网 http://192.168.x.x:8788 打开时 navigator.wakeLock 是 undefined，
   *    怎么调都没用 —— 这曾经是「iPad 自己锁屏」的真正原因。
   *    部署到 GitHub Pages（HTTPS）后才会真正生效。
   *
   * 另外：单句 / 跟读模式每到句尾就 pause，靠「视频在播」本身防不住锁屏，
   * 所以必须显式申请、暂停时按需保持。
   */
  let wakeLock = null;
  let wakeHinted = false;
  let wakeIdleTimer = 0;

  function paintWakeChip() {
    const on = !!wakeLock && !wakeLock.released;
    wakeChip.hidden = !on;
  }
  /* 暂停 ≠ 结束。单句 / 跟读模式每隔几秒就 pause 一次，一暂停就放开常亮，
     孩子跟着念的时候屏幕反而灭了。所以暂停后**保持**常亮，只有长时间
     （默认 2 分钟）没动静才放开，让 iPad 正常息屏省电。 */
  function scheduleWakeRelease(ms = 120000) {
    clearTimeout(wakeIdleTimer);
    wakeIdleTimer = setTimeout(releaseWake, ms);
  }
  async function acquireWake() {
    clearTimeout(wakeIdleTimer);
    if (!S.keepAwake) return;
    if (!('wakeLock' in navigator)) {
      if (!wakeHinted) {
        wakeHinted = true;
        toast('当前地址不支持自动防锁屏（需要 HTTPS）。可在 iPad「设置 → 显示与亮度 → 自动锁定」里选「永不」', 5600);
      }
      return;
    }
    if (document.visibilityState !== 'visible') return;   // 页面不可见时申请必被拒
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; paintWakeChip(); });
      paintWakeChip();
    } catch {
      wakeLock = null;                                    // 别在 NotAllowedError 上打转
      paintWakeChip();
    }
  }
  function releaseWake() {
    clearTimeout(wakeIdleTimer);
    try { if (wakeLock) wakeLock.release(); } catch {}
    wakeLock = null;
    paintWakeChip();
  }
  // 系统在页面隐藏时会强制释放；回来时若还在播就重新申请
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { wakeLock = null; paintWakeChip(); }
    else if (S.playState === 'playing') acquireWake();
  });

  /* ------------------------------------------------ 缓冲指示 */
  function setBuffering(on) {
    bufSpinner.hidden = !on;
  }
  ['waiting', 'stalled', 'seeking'].forEach((ev) =>
    video.addEventListener(ev, () => setBuffering(true)));
  ['playing', 'canplay', 'seeked', 'pause', 'error', 'loadedmetadata'].forEach((ev) =>
    video.addEventListener(ev, () => setBuffering(false)));

  /* ------------------------------------------------ 本机缓存（加快跳转）
   *
   * 打开一集时 content.js 已经优先给了本机 blob；这里负责「没有就后台补上」。
   * 刻意等播放稳定 2.5 秒再开始下载，避免和首屏缓冲抢带宽。
   * 下载**不打断当前播放**，只对「下一次」生效 —— 换源会丢播放位置，不值得。
   */
  let cacheStarted = false;

  function paintCacheChip(state, ratio) {
    if (state === 'off') { cacheChip.hidden = true; return; }
    cacheChip.hidden = false;
    cacheChip.dataset.state = state;
    cacheChip.textContent = {
      local: '本机播放',
      saving: `缓存到本机 ${Math.round((ratio || 0) * 100)}%`,
      skip: '视频较大，不缓存',
      fail: '缓存失败（下次播放重试）',
    }[state] || '';
  }

  async function startCache() {
    if (ep.source !== 'mounted') return;                 // 导入的集本来就在本机
    if (S.cached) { paintCacheChip('local'); return; }
    if (!S.cacheMode) { paintCacheChip('off'); return; }
    if (await isCached(ep.id)) { S.cached = true; paintCacheChip('local'); return; }
    if (!ep.video) { paintCacheChip('off'); return; }

    paintCacheChip('saving', 0);
    try {
      const netUrl = new URL(ep.video, location.href).href;
      const r = await cacheEpisode(ep.id, netUrl, {
        title: ep.title,
        durationSeconds: ep.durationSeconds,
        onProgress: (ratio) => paintCacheChip('saving', ratio),
      });
      if (r.ok) { S.cached = true; paintCacheChip('local'); }
      else paintCacheChip(r.reason === 'too-big' ? 'skip' : 'off');
    } catch {
      paintCacheChip('fail');
    }
  }

  /* 进度条拖拽 */
  let scrubbing = false;
  const ratioOf = (clientX) => {
    const r = scrubEl.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
  };
  const seekToRatio = (clientX) => {
    const d = mediaDuration();
    if (!d) return;
    const t = ratioOf(clientX) * d;
    video.currentTime = t;
    S.seekAt = performance.now();
    timeNow.textContent = fmtTime(t);
    scrubFill.style.width = `${ratioOf(clientX) * 100}%`;
    scrubKnob.style.left = `${ratioOf(clientX) * 100}%`;
    updateActive(t);
  };
  scrubEl.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    try { scrubEl.setPointerCapture(e.pointerId); } catch {}
    seekToRatio(e.clientX);
  });
  scrubEl.addEventListener('pointermove', (e) => { if (scrubbing) seekToRatio(e.clientX); });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { scrubEl.releasePointerCapture(e.pointerId); } catch {}
    saveNow();
  };
  scrubEl.addEventListener('pointerup', endScrub);
  scrubEl.addEventListener('pointercancel', endScrub);
  scrubEl.addEventListener('keydown', (e) => {
    const d = mediaDuration();
    let t = video.currentTime;
    if (e.key === 'ArrowLeft') t -= e.shiftKey ? 15 : 5;
    else if (e.key === 'ArrowRight') t += e.shiftKey ? 15 : 5;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = d;
    else return;
    e.preventDefault();
    video.currentTime = clamp(t, 0, d);
    S.seekAt = performance.now();
  });

  /* ------------------------------------------------------------ 模式 / 速度 / 中文 */

  function setMode(m) {
    if (S.mode === m) return;
    S.mode = m;
    setPrefs({ mode: m });
    modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    wbRoot.dataset.mode = m;
    // 4.3 切换模式保留当前时间，并选中对应句子
    const idx = S.activeIndex >= 0 ? S.activeIndex : findActiveIndex(video.currentTime);
    if (idx >= 0 && m !== 'continuous') {
      S.selectedIndex = idx;
      S.follow = true; paintFollow();
    }
    paint();
    if (m === 'continuous') clearGap();
    if (m !== 'continuous') {
      const target = S.selectedIndex;
      if (target != null && lines[target]) selectLine(target, { play: !video.paused });
    }
    toast({
      continuous: '连续模式：整集连播',
      single: '单句模式：播放到句尾会暂停',
      shadow: `跟读模式：每句后留 ${S.gapSec} 秒，跟着念一遍`,
    }[m]);
  }

  function setGap(g) {
    S.gapSec = g;
    setPrefs({ gapSeconds: g });
    gapBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.gap) === g)));
    if (S.gapLeft > 0) { S.gapLeft = g; paintGap(); }
    toast(`跟读留白 ${g} 秒`);
  }

  function setRate(r) {
    S.rate = r;
    setPrefs({ rate: r });
    applyRate();
    rateBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === r)));
    toast(`速度 ${r}×（播放位置不变）`);
  }
  function applyRate() { video.playbackRate = S.rate; }

  /* ------------------------------------------------------------ 播完怎么办 */

  function setEndMode(m) {
    if (!END_MODES.includes(m) || S.endMode === m) return;
    S.endMode = m;
    setPrefs({ endMode: m });
    applyEndMode();
    endBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.end === m)));
    toast({
      loop: '播完这一集，会自动从头再听一遍',
      across: '播完这一集，自动接着听下一集',
      stop: '这一集播完就停下',
    }[m]);
  }
  /** 循环用原生 loop（无缝、不闪黑），另两种交给 ended 事件 */
  function applyEndMode() { video.loop = S.endMode === 'loop'; }

  /** 取同合集里的下一集；已经是本合集最后一集则返回 null（不跨动画连播） */
  async function nextEpisode() {
    try {
      const cat = await loadCatalog();
      const list = (cat.episodes || []).filter((e) => (e.series || '') === (ep.series || ''));
      const i = list.findIndex((e) => e.id === ep.id);
      if (i < 0 || i + 1 >= list.length) return null;
      return list[i + 1];
    } catch { return null; }
  }

  async function onEnded() {
    saveNow();
    if (S.endMode === 'across') {
      const next = await nextEpisode();
      const show = ep.seriesMeta?.title || '这一部';
      if (!next) { toast(`《${show}》就这几集，都听完啦`); return; }
      toast(`这一集听完啦，接着听《${next.title}》`);
      location.hash = `#/watch/${next.id}`;
      return;
    }
    toast('这一集听完啦');
  }
  video.addEventListener('ended', onEnded);

  /* ------------------------------------------------------------ 播放器字幕四态 */

  function setSubMode(m) {
    if (!SUBTITLE_MODES.includes(m) || S.subMode === m) return;
    S.subMode = m;
    setPrefs({ subtitleMode: m });
    subLayer.dataset.mode = m;
    subBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === m)));
    toast({
      off: '字幕已关闭',
      zh: '字幕：只看中文',
      en: '字幕：只看英文',
      both: '字幕：中英文一起看',
    }[m]);
  }
  function cycleSubMode() {
    const i = SUBTITLE_MODES.indexOf(S.subMode);
    setSubMode(SUBTITLE_MODES[(i + 1) % SUBTITLE_MODES.length]);
  }

  /* ------------------------------------------------------------ 盲听（先听后看） */

  function toggleBlind() {
    S.blind = !S.blind;
    setPrefs({ blindFirst: S.blind });
    applyBlind();
    paintBlindBtn();
    if (S.blind) {
      // 重新遮住：清掉之前揭示过的行
      rowEls.forEach((r) => { r.dataset.revealed = '0'; });
      S.follow = true; paintFollow();
      autoScrollTo(S.activeIndex >= 0 ? S.activeIndex : (S.selectedIndex ?? 0));
      toast('盲听模式：先只用耳朵听，点某一句才揭示英文');
    } else {
      toast('已显示英文字幕');
    }
    paint();
  }
  function applyBlind() { document.body.classList.toggle('blind', S.blind); }
  function paintBlindBtn() {
    clear(blindBtn);
    blindBtn.appendChild(icon(S.blind ? 'ear' : 'eyeOff'));
    blindBtn.appendChild(document.createTextNode(S.blind ? '盲听：开' : '盲听：关'));
    blindBtn.setAttribute('aria-pressed', String(S.blind));
    blindBtn.title = S.blind ? '英文已遮住，点某句可揭示' : '遮住英文，先听一遍再看';
  }

  /* ------------------------------------------------------------ 闪卡 */

  /** 例句里把目标词高亮出来（带复数/时态等词尾变化一起标） */
  function highlightWord(text, word) {
    const safe = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = String(text).split(new RegExp(`(${safe}\\w*)`, 'i'));
    return parts.filter((p) => p !== '')
      .map((p, i) => (i % 2 ? h('mark.fc-mark', p) : document.createTextNode(p)));
  }

  /** 比「例句是否就是短语本身」，用来决定卡片背面要不要再贴一遍原句 */
  function sameText(a, b) {
    return String(a).replace(/\s+/g, ' ').trim().toLowerCase()
      === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * 从闪卡跳到字幕：定位到那一句并播放。
   *
   * 刻意**不切页签** —— 孩子是一边看闪卡一边听，自动跳到字幕页签等于
   * 逼他看完再切回来。反馈交给三处：播放器上会显示这一句的字幕、
   * 被点的卡片闪一圈、底部提示跳到了哪个时间点。
   * 字幕页签只在「已经开着」时才滚动+闪烁；下次手动切过去时，
   * setTab 会跟着当前播放句滚到正确位置。
   */
  function jumpToLine(i, card) {
    if (!(i >= 0 && i < lines.length)) return;
    selectLine(i, { play: true });
    if (S.sideTab === 'subs') {
      autoScrollTo(i);
      flash(rowEls[i], 'trow-flash');
    }
    flash(card, 'fc-jump');
    toast(`已跳到 ${fmtShort(lines[i].start)} 这一句`);
  }

  function flash(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;                        // 强制重排，让动画能重复触发
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1400);
  }

  function paintFcCount() {
    if (!words.length) { fcCount.textContent = ''; return; }
    const n = words.filter((w) => isCardKnown(ep.id, w.en)).length;
    fcCount.textContent = `已会 ${n} / ${words.length}`;
  }

  function refreshCard(card, w) {
    const known = isCardKnown(ep.id, w.en);
    card.dataset.known = known ? '1' : '0';
    const badge = card.querySelector('.fc-known');
    if (badge) badge.hidden = !known;
    const knowBtn = card.querySelector('.fc-btn-know');
    if (knowBtn) {
      const label = known ? '还没会' : '我会了';
      clear(knowBtn);
      append(knowBtn, label);
      knowBtn.title = known ? '点一下改回「还没会」' : '点一下标记「我会了」';
      knowBtn.setAttribute('aria-label', label);
    }
    paintFcCount();
  }

  function buildCards() {
    clear(fcRow);
    words.forEach((w) => {
      const isPhrase = w.type === 'phrase';
      const L = Number.isInteger(w.line) && lines[w.line] ? lines[w.line] : null;
      // 短语卡：只有当原句比短语本身更长时，才在背面把它当上下文贴出来
      const showContext = L && (!isPhrase || !sameText(L.en, w.en));
      const front = h('div.fc-face.fc-front',
        isPhrase ? h('span.fc-kind', '短语') : null,
        h('span.fc-emoji', w.emoji || ''),
        h('span.fc-word', w.en),
        h('span.fc-known', { hidden: true }, icon('check')),
        h('span.fc-hint', isPhrase ? '点我看中文' : '点我看意思'));
      const back = h('div.fc-face.fc-back',
        h('span.fc-zh', w.zh || ''),
        showContext ? h('p.fc-line', highlightWord(L.en, w.en)) : null,
        h('div.fc-actions',
          L ? h('button.fc-btn', {
            type: 'button',
            title: '跳到字幕里这一句（会留在闪卡页签，字幕显示在画面上）',
            onclick: (e) => {
              e.stopPropagation();
              jumpToLine(w.line, e.currentTarget.closest('.fc-card'));
            },
          }, '听这句') : null,
          h('button.fc-btn.fc-btn-know', {
            type: 'button',
            onclick: (e) => {
              e.stopPropagation();
              const card = e.currentTarget.closest('.fc-card');
              setCardKnown(ep.id, w.en, !isCardKnown(ep.id, w.en));
              refreshCard(card, w);
            },
          })),
        h('span.fc-hint', '再点一下翻回去'));
      const card = h('button.fc-card', {
        type: 'button',
        role: 'listitem',
        dataset: {
          kind: isPhrase ? 'phrase' : 'word',
          known: isCardKnown(ep.id, w.en) ? '1' : '0',
          flip: '0',
        },
        'aria-label': `${w.en}，${w.zh || ''}`,
        onclick: () => { card.dataset.flip = card.dataset.flip === '1' ? '0' : '1'; },
      }, h('div.fc-inner', front, back));
      refreshCard(card, w);   // 让「我会了 / 还没会」一生成就有字，别是个空按钮
      fcRow.appendChild(card);
    });
    paintFcCount();
  }

  /* ------------------------------------------------------------ 跟读留白 */

  function startGap() {
    clearInterval(S.gapTimer);
    S.gapLeft = S.gapSec;
    paintGap();
    S.gapTimer = setInterval(() => {
      S.gapLeft -= 0.25;
      if (S.gapLeft <= 0) {
        clearInterval(S.gapTimer);
        S.gapTimer = 0;
        S.gapLeft = 0;
        paintGap();
        advanceShadow();
      } else {
        paintGap();
      }
    }, 250);
  }
  function clearGap() {
    if (S.gapTimer) { clearInterval(S.gapTimer); S.gapTimer = 0; }
    S.gapLeft = 0;
    paintGap();
  }
  function paintGap() {
    if (S.gapLeft > 0) {
      gapChip.hidden = false;
      gapText.textContent = `跟读一遍 · ${Math.ceil(S.gapLeft)}`;
      gapBar.style.width = `${(1 - S.gapLeft / Math.max(S.gapSec, 0.25)) * 100}%`;
    } else {
      gapChip.hidden = true;
    }
  }
  function advanceShadow() {
    const cur = S.selectedIndex;
    if (cur == null) return;
    if (cur >= lines.length - 1) {
      toast('这一集跟读完成');
      paintGap();
      return;
    }
    selectLine(cur + 1, { play: true });
  }

  /* ------------------------------------------------------------ 句子操作 */

  function selectLine(i, { play = true, keepSelection = false } = {}) {
    if (i < 0 || i >= lines.length) return;
    const L = lines[i];
    if (!keepSelection) S.selectedIndex = i;
    S.follow = true;
    paintFollow();
    video.currentTime = L.start;
    S.seekAt = performance.now();
    S.activeIndex = i;
    paint();
    timeNow.textContent = fmtTime(L.start);
    if (play) video.play().catch(() => {});
  }

  function targetIndex() {
    if (S.mode === 'single' && S.selectedIndex != null) return S.selectedIndex;
    if (S.activeIndex >= 0) return S.activeIndex;
    return S.selectedIndex ?? 0;
  }

  function stepLine(delta) {
    const cur = targetIndex();
    let next = cur + delta;
    if (next < 0) { toast('已经是第一句'); next = 0; }
    if (next > lines.length - 1) { toast('已经是最后一句'); next = lines.length - 1; }
    selectLine(next, { play: true });
  }

  function replay() {
    const i = targetIndex();
    if (lines[i] == null) return;
    selectLine(i, { play: true });
    toast('再听一次');
  }

  /** 单句 / 跟读模式：到句尾暂停；跟读模式再留白若干秒后自动进入下一句 */
  function checkSentenceEnd() {
    if (S.mode === 'continuous' || S.selectedIndex == null) return;
    if (video.paused || video.seeking) return;
    if (performance.now() - S.seekAt < 300) return;
    const L = lines[S.selectedIndex];
    if (!L) return;
    const t = video.currentTime;
    if (t >= L.end - 0.03 && t > L.start) {
      video.pause();
      if (S.mode === 'shadow') startGap();
    }
  }

  /* ------------------------------------------------------------ 帧循环 */

  function tick() {
    if (!video.paused) {
      const t = video.currentTime || 0;
      updateActive(t);
      timeNow.textContent = fmtTime(t);
      const d = mediaDuration();
      if (d) {
        const pct = (t / d) * 100;
        scrubFill.style.width = `${pct}%`;
        scrubKnob.style.left = `${pct}%`;
        scrubEl.setAttribute('aria-valuenow', String(Math.round(t)));
      }
      checkSentenceEnd();
    }
    S.rafId = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------ 进度记忆 */

  function saveNow() {
    S.lastSavedAt = Date.now();
    if (!lines.length && !(video.currentTime > 0)) return;
    saveProgress(ep.id, video.currentTime || 0, S.activeIndex >= 0 ? S.activeIndex : S.selectedIndex);
  }

  function restoreProgress() {
    const p = getProgress(ep.id);
    if (!p || !(p.lastPositionSeconds > 3)) return;
    const d = mediaDuration();
    if (d && p.lastPositionSeconds > d - 2) return;
    video.currentTime = p.lastPositionSeconds;
    S.seekAt = performance.now();

    const target = Number.isInteger(p.lastLineIndex) ? p.lastLineIndex : findActiveIndex(p.lastPositionSeconds);
    if (target >= 0 && lines[target]) S.selectedIndex = target;
    S.activeIndex = target;
    paint();

    clear(resumeBar);
    resumeBar.hidden = false;
    append(resumeBar,
      icon('info'),
      h('span.resume-text', `已恢复到上次听到的 ${fmtTime(p.lastPositionSeconds)}`),
      h('button.btn.btn-ghost', {
        type: 'button',
        onclick: () => {
          video.currentTime = 0;
          S.seekAt = performance.now();
          S.selectedIndex = null;
          S.activeIndex = -1;
          paint();
          resumeBar.hidden = true;
        },
      }, '从头开始'),
      h('button.btn.btn-ghost', {
        type: 'button', onclick: () => { resumeBar.hidden = true; },
      }, '知道了'),
    );
  }

  const onHide = () => saveNow();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  /* ------------------------------------------------------------ 键盘（桌面便利） */

  function onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); playPause(); }
    else if (e.key === 'ArrowLeft' && tag !== 'BUTTON' && e.target !== scrubEl) { e.preventDefault(); stepLine(-1); }
    else if (e.key === 'ArrowRight' && tag !== 'BUTTON' && e.target !== scrubEl) { e.preventDefault(); stepLine(1); }
    else if (e.key === 'r' || e.key === 'R') { replay(); }
    else if (e.key === 'c' || e.key === 'C') { cycleSubMode(); }
    else if (e.key === 'b' || e.key === 'B') { toggleBlind(); }
    // 顶栏收起的实现住在 app.js（顶栏归它管），这里只发一个信号
    else if (e.key === 't' || e.key === 'T') { emit('topbar:toggle'); }
  }
  document.addEventListener('keydown', onKey);

  /* 清理（路由离开时） */
  const cleanup = () => {
    cancelAnimationFrame(S.rafId);
    clearGap();
    clearTimeout(chromeTimer);
    releaseWake();
    setBuffering(false);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    saveNow();
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  };

  /* ------------------------------------------------------------ 初始化 */

  buildRows();
  paintBlindBtn();
  paintFollow();
  paintGap();
  paintHeadStatus();
  buildCards();
  paint();
  timeTotal.textContent = ep.durationSeconds ? fmtTime(ep.durationSeconds) : '--:--';
  S.cached = ep.source === 'mounted' && String(sources[0] || '').startsWith('blob:');
  if (S.cached) paintCacheChip('local');
  else if (!S.cacheMode) paintCacheChip('off');
  applyRate();
  applyEndMode();
  applyBlind();
  await tryLoadSource();
  S.rafId = requestAnimationFrame(tick);

  return cleanup;
}
