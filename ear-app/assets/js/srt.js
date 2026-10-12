/* SRT / WebVTT 解析 + 断句整理（与 scripts/build_content.py 保持同一套规则） */

const TAG_ONLY = /^[\[\(（【]\s*[^\]\)）】]*\s*[\]\)）】]$/;
const TERMINAL = /[.!?…]["'”’)\]】]*\s*$/;

export function parseTimecode(str) {
  // 支持 00:00:01,330 与 00:00:01.330 与 00:01.330
  const m = String(str).trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

export function looksLikeSrt(text) {
  return /-->/.test(text);
}

/** 解析 SRT / VTT → [{start, end, text}] */
export function parseSrt(raw) {
  const src = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const cues = [];
  for (const block of src.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) && lines.length === 1) continue;
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseTimecode(a);
    const end = parseTimecode(b);
    if (start == null || end == null || end <= start) continue;
    const text = lines.slice(idx + 1).join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    if (!text) continue;
    if (TAG_ONLY.test(text)) continue;
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  return cues;
}

/** 把 ASR 碎片合并成完整句子 */
export function mergeSentences(cues, { maxGap = 0.8, maxDur = 6.5, maxWords = 15 } = {}) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) { cur = { start: c.start, end: c.end, text: c.text }; continue; }
    const gap = c.start - cur.end;
    const words = cur.text.split(/\s+/).filter(Boolean).length;
    const nextWords = c.text.split(/\s+/).filter(Boolean).length;
    const dur = cur.end - cur.start;
    if (gap <= maxGap && !TERMINAL.test(cur.text) && dur < maxDur && words + nextWords <= maxWords) {
      cur.text += ' ' + c.text;
      cur.end = c.end;
    } else {
      out.push(cur);
      cur = { start: c.start, end: c.end, text: c.text };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 为每句英文匹配时间重叠最多的中文提示 */
export function attachChinese(sentences, zhCues) {
  return sentences.map((s) => {
    const parts = [];
    for (const z of zhCues) {
      const ov = Math.min(s.end, z.end) - Math.max(s.start, z.start);
      if (ov <= 0.05) continue;
      if (!parts.includes(z.text)) parts.push(z.text);
    }
    return { start: s.start, end: s.end, en: s.text, zh: parts.join(' ').trim() };
  });
}

/** 把句子数组转成应用内部行结构 */
export function toLines(sentences) {
  return sentences.map((s, i) => ({
    i: i + 1,
    start: Math.round(s.start * 1000) / 1000,
    end: Math.round(s.end * 1000) / 1000,
    en: s.en,
    zh: s.zh || '',
  }));
}

/**
 * 校验（方案 §5.3 / §9）
 * 返回 { issues: [{level, title, msg}], stats: {...} }
 */
export function validate({ lines, durationSeconds, hasVideo, hasZhTrack }) {
  const issues = [];
  const stats = {
    total: lines.length,
    withZh: lines.filter((l) => String(l.zh || '').trim()).length,
    overlaps: 0,
    outOfRange: 0,
    nonPositive: 0,
    empty: 0,
    maxEnd: lines.length ? lines[lines.length - 1].end : 0,
  };

  if (!hasVideo) issues.push({ level: 'err', title: '缺少视频', msg: '没有选择可播放的视频文件。' });
  if (!lines.length) issues.push({ level: 'err', title: '字幕为空', msg: '没有解析到任何字幕后，无法做单句精听。' });

  lines.forEach((l, i) => {
    if (!String(l.en || '').trim()) { stats.empty++; issues.push({ level: 'warn', title: `第 ${i + 1} 句英文为空`, msg: '建议删除或补齐这一句。' }); }
    if (!(l.end > l.start)) { stats.nonPositive++; issues.push({ level: 'err', title: `第 ${i + 1} 句时长无效`, msg: `start=${l.start}s end=${l.end}s` }); }
  });

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].end - 0.02) {
      stats.overlaps++;
      if (stats.overlaps <= 6) {
        issues.push({ level: 'warn', title: `第 ${i} 句与上一句重叠`, msg: `上一句到 ${lines[i - 1].end}s，本句从 ${lines[i].start}s 开始。` });
      }
    }
  }
  if (stats.overlaps > 6) issues.push({ level: 'warn', title: `共 ${stats.overlaps} 处重叠`, msg: '播放时可正常匹配（取最近开始的一句），但建议整理时间轴。' });

  if (durationSeconds && stats.maxEnd > durationSeconds + 0.5) {
    stats.outOfRange = 1;
    issues.push({ level: 'err', title: '字幕超出视频时长', msg: `最后一句结束于 ${stats.maxEnd.toFixed(1)}s，视频只有 ${durationSeconds.toFixed(1)}s。` });
  }

  if (lines.length && stats.withZh === 0 && hasZhTrack !== true) {
    issues.push({ level: 'warn', title: '没有中文提示', msg: '英文与时间码可用，但中文提示缺失；可在字幕表里以「无中文」标注。' });
  }

  if (!issues.length) issues.push({ level: 'ok', title: '校验通过', msg: '时间轴连续、无越界、英文与中文提示齐备。' });
  return { issues, stats };
}
