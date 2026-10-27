import { Resvg } from '@resvg/resvg-js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { displayRow, layoutOf } from './aggregator.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// Browser-free fallback for the report image (same table, colours and columns as renderReportHtml).
// Used only when Chromium is not installed, e.g. on Render's native Node runtime.

const FONT = 15;
const HEAD_FONT = 13;
const PAD = 16;
const ROW_H = 36;
const HEAD_H = 34;
const TITLE_H = 44;
const META_LINE_H = 20;
const C = {
  title: '#203B68', border: '#b7c7dd', alt: '#DCE9F7', yellow: '#FFF2B3', lgreen: '#D8F0DC', talk: '#1B7A3E',
  groups: { agent: '#203B68', vol: '#3278B8', dur: '#218346', disp: '#68223F' },
  subs: { vol: '#4A8CC9', dur: '#2E9A57', disp: '#84304F' },
  meta: '#f6f8fb', metaText: '#4b5b73', white: '#ffffff', ink: '#1f2937',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Rough text width: enough to size columns so no value is cut off. */
const textWidth = (s, size = FONT, bold = false) => String(s ?? '').length * size * (bold ? 0.62 : 0.56) + 4;

export function buildReportSvg(report, { tz = 'Asia/Kolkata' } = {}) {
  const av = report.availability;
  const layout = layoutOf(report);
  const rows = report.agents.map((a) => displayRow(a, av));
  const total = displayRow(report.total, av);
  const cells = (d) => [d.totalCalls, d.answered, d.missed, d.talk, d.hold, d.wrap, ...(layout.dispositions ? [d.interested, d.notInterested, d.callBack, d.answeredDisp] : [])];
  const subHeaders = ['Total Calls', 'Answered', 'Missed', 'Actual Talk Time', layout.holdLabel, layout.wrapLabel, ...(layout.dispositions ? ['Interested', 'Not Interested', 'Call Back', 'Answered (Disp)'] : [])];
  const groups = [
    { label: 'Call Volume', span: 3, fill: C.groups.vol, sub: C.subs.vol },
    { label: 'Duration', span: 3, fill: C.groups.dur, sub: C.subs.dur },
    ...(layout.dispositions ? [{ label: 'Dispositions', span: 4, fill: C.groups.disp, sub: C.subs.disp }] : []),
  ];

  // Column widths: wide enough for the longest header or value in each column
  const agentW = Math.max(180, ...['Agent', 'TOTAL', ...rows.map((r) => r.agent)].map((s) => textWidth(s, FONT, true) + PAD * 2));
  const colW = subHeaders.map((h, i) => Math.max(
    textWidth(h, HEAD_FONT, true),
    textWidth(cells(total)[i], FONT, true),
    ...rows.map((r) => textWidth(cells(r)[i])),
  ) + PAD * 2);
  const width = agentW + colW.reduce((s, w) => s + w, 0);

  const notes = [...report.notes];
  if ([av.talk, av.hold, av.wrap].includes('partial')) notes.push('* Partial value — some counted calls had no value for this metric.');
  const generated = `Generated ${dayjs(report.generatedAt).tz(tz).format('DD MMM YYYY, hh:mm A')} IST · ${report.agents.length} agent(s) · ${report.sources.length} source file(s)`;
  const metaLines = [generated, ...notes];

  const out = [];
  const rect = (x, y, w, h, fill) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${C.border}" stroke-width="1"/>`);
  const text = (x, y, w, h, value, { bold = false, size = FONT, fill = C.ink, anchor = 'middle' } = {}) => {
    const tx = anchor === 'start' ? x + PAD : x + w / 2;
    out.push(`<text x="${tx}" y="${y + h / 2}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="central">${esc(value)}</text>`);
  };

  // Title
  const titleText = `${report.title} | Date: ${report.reportDate}`;
  rect(0, 0, width, TITLE_H, C.title);
  text(0, 0, width, TITLE_H, titleText, { bold: true, size: 22, fill: C.white });

  // Header row 1: group labels
  let y = TITLE_H;
  rect(0, y, agentW, HEAD_H * 2, C.groups.agent);
  text(0, y, agentW, HEAD_H * 2, 'Agent', { bold: true, size: 16, fill: C.white });
  for (const g of groups) {
    const start = groupStart(groups, g);
    const gx = agentW + colW.slice(0, start).reduce((s, v) => s + v, 0);
    const gw = colW.slice(start, start + g.span).reduce((s, v) => s + v, 0);
    rect(gx, y, gw, HEAD_H, g.fill);
    text(gx, y, gw, HEAD_H, g.label, { bold: true, size: 16, fill: C.white });
  }
  // Header row 2: sub labels
  y += HEAD_H;
  let x = agentW;
  subHeaders.forEach((h, i) => {
    const sub = subFill(groups, i);
    rect(x, y, colW[i], HEAD_H, sub);
    text(x, y, colW[i], HEAD_H, h, { bold: true, size: HEAD_FONT, fill: C.white });
    x += colW[i];
  });

  // Body rows
  y += HEAD_H;
  rows.forEach((r, i) => {
    const base = i % 2 === 0 ? C.alt : C.white;
    let cx = agentW;
    rect(0, y, agentW, ROW_H, base);
    text(0, y, agentW, ROW_H, r.agent, { bold: true, anchor: 'start' });
    cells(r).forEach((v, c) => {
      const fill = dispFill(layout, c) ?? base;
      rect(cx, y, colW[c], ROW_H, fill);
      text(cx, y, colW[c], ROW_H, v, { fill: c === 3 ? C.talk : C.ink, bold: c === 3 });
      cx += colW[c];
    });
    y += ROW_H;
  });

  // Total row
  rect(0, y, agentW, ROW_H, C.title);
  text(0, y, agentW, ROW_H, 'TOTAL', { bold: true, fill: C.white, anchor: 'start' });
  let tx = agentW;
  cells(total).forEach((v, c) => {
    rect(tx, y, colW[c], ROW_H, C.title);
    text(tx, y, colW[c], ROW_H, v, { bold: true, fill: C.white });
    tx += colW[c];
  });
  y += ROW_H;

  // Footer
  const metaH = metaLines.length * META_LINE_H + 16;
  rect(0, y, width, metaH, C.meta);
  metaLines.forEach((line, i) => text(0, y + 8 + i * META_LINE_H - (META_LINE_H - 14) / 2, width, META_LINE_H, line, { size: 11, fill: C.metaText, anchor: 'start' }));
  y += metaH;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(y)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(y)}">
<rect width="100%" height="100%" fill="${C.white}"/>
${out.join('\n')}
</svg>`;
}

/** Index of the first column of a group, in the sub-header list. */
function groupStart(groups, target) {
  let start = 0;
  for (const g of groups) { if (g === target) return start; start += g.span; }
  return start;
}

/** Header colour of a sub-column: volume, duration or disposition. */
function subFill(groups, i) {
  let start = 0;
  for (const g of groups) {
    if (i < start + g.span) return g.sub;
    start += g.span;
  }
  return C.subs.vol;
}

/** Background of a disposition value cell, matching the browser version (yellow / light green). */
function dispFill(layout, c) {
  if (!layout.dispositions || c < 6) return null;
  if (c === 7 || c === 8) return C.yellow;
  if (c === 9) return C.lgreen;
  return null;
}

/** Report as a PNG without a browser (2x resolution, like the browser version). */
export function renderReportSvgPng(report, opts) {
  const svg = buildReportSvg(report, opts);
  const png = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 2 },
    font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
  }).render().asPng();
  return Buffer.from(png);
}
