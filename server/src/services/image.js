import { chromium } from 'playwright';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { config } from '../config.js';
import { displayRow, layoutOf } from './aggregator.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Self-contained HTML for the report image. All numbers come from `report` (same object as the Excel). */
export function renderReportHtml(report, { tz = 'Asia/Kolkata' } = {}) {
  const av = report.availability;
  const layout = layoutOf(report);
  const dispCells = (d) => (layout.dispositions ? `<td>${d.interested}</td><td class="yellow">${d.notInterested}</td><td class="yellow">${d.callBack}</td><td class="lgreen">${d.answeredDisp}</td>` : '');
  const rows = report.agents.map((a, i) => {
    const d = displayRow(a, av);
    return `<tr class="${i % 2 === 0 ? 'alt' : ''}">
      <td class="agent">${esc(d.agent)}</td><td>${d.totalCalls}</td><td>${d.answered}</td><td>${d.missed}</td>
      <td class="talk">${d.talk}</td><td>${d.hold}</td><td>${d.wrap}</td>${dispCells(d)}</tr>`;
  }).join('');
  const t = displayRow(report.total, av);
  const rangeText = `${report.dateFrom} to ${report.dateTo}`;
  const period = report.dateFrom && report.dateTo && report.dateFrom !== report.dateTo && report.reportDate !== rangeText ? ` (${esc(rangeText)})` : '';
  const footnotes = [...report.notes];
  if ([av.talk, av.hold, av.wrap].includes('partial')) footnotes.push('* Partial value — some counted calls had no value for this metric.');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #fff; font-family: 'Segoe UI', 'Inter', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; color: #1f2937; display: inline-block; }
  #report { display: inline-block; border: 1px solid #b7c7dd; border-radius: 6px; overflow: hidden; }
  .title { background: #203B68; color: #fff; font-size: 22px; font-weight: 700; padding: 14px 24px; text-align: center; white-space: nowrap; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #b7c7dd; padding: 9px 16px; text-align: center; white-space: nowrap; font-size: 15px; }
  th { color: #fff; font-weight: 700; }
  .g-agent { background: #203B68; font-size: 16px; min-width: 180px; }
  .g-vol { background: #3278B8; font-size: 16px; }
  .g-dur { background: #218346; font-size: 16px; }
  .g-disp { background: #68223F; font-size: 16px; }
  .s-vol { background: #4A8CC9; font-size: 13px; }
  .s-dur { background: #2E9A57; font-size: 13px; }
  .s-disp { background: #84304F; font-size: 13px; }
  tr.alt td { background: #DCE9F7; }
  td.agent { text-align: left; font-weight: 700; }
  td.talk { color: #1B7A3E; font-weight: 700; }
  td.yellow, tr.alt td.yellow { background: #FFF2B3; }
  td.lgreen, tr.alt td.lgreen { background: #D8F0DC; }
  tr.total td { background: #203B68 !important; color: #fff; font-weight: 700; }
  .meta { font-size: 11px; color: #4b5b73; padding: 8px 16px; background: #f6f8fb; border-top: 1px solid #b7c7dd; width: 0; min-width: 100%; }
  .meta div { margin: 2px 0; white-space: normal; }
  </style></head><body><div id="report">
  <div class="title">${esc(report.title)} | Date: ${esc(report.reportDate)}${period}</div>
  <table>
    <thead>
      <tr><th class="g-agent" rowspan="2">Agent</th><th class="g-vol" colspan="3">Call Volume</th><th class="g-dur" colspan="3">Duration</th>${layout.dispositions ? '<th class="g-disp" colspan="4">Dispositions</th>' : ''}</tr>
      <tr><th class="s-vol">Total Calls</th><th class="s-vol">Answered</th><th class="s-vol">Missed</th>
          <th class="s-dur">Actual Talk Time</th><th class="s-dur">${esc(layout.holdLabel)}</th><th class="s-dur">${esc(layout.wrapLabel)}</th>
          ${layout.dispositions ? '<th class="s-disp">Interested</th><th class="s-disp">Not Interested</th><th class="s-disp">Call Back</th><th class="s-disp">Answered (Disp)</th>' : ''}</tr>
    </thead>
    <tbody>${rows}
      <tr class="total"><td class="agent">TOTAL</td><td>${t.totalCalls}</td><td>${t.answered}</td><td>${t.missed}</td><td>${t.talk}</td><td>${t.hold}</td><td>${t.wrap}</td>${layout.dispositions ? `<td>${t.interested}</td><td>${t.notInterested}</td><td>${t.callBack}</td><td>${t.answeredDisp}</td>` : ''}</tr>
    </tbody>
  </table>
  <div class="meta"><div>Generated ${esc(dayjs(report.generatedAt).tz(tz).format('DD MMM YYYY, hh:mm A'))} IST · ${report.agents.length} agent(s) · ${report.sources.length} source file(s)</div>${footnotes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>
  </div></body></html>`;
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: config.chromiumPath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu'],
    }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise.catch(() => null); browserPromise = null; await b?.close(); }
}

/**
 * Render the report to a 2x-resolution PNG.
 * We start with a very wide viewport, then measure the real rendered size of #report
 * and resize the viewport to match — so nothing is ever clipped regardless of table width.
 */
export async function renderReportPng(report, opts) {
  const html = renderReportHtml(report, opts);
  const browser = await getBrowser();
  // Use an extra-wide initial viewport to allow full layout before measuring
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 4000, height: 2000 },
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    // Block all external network requests so rendering is fast and deterministic
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: 'load' });

    const el = await page.$('#report');
    if (!el) {
      // Fallback: screenshot the whole body
      const body = await page.$('body');
      return await body.screenshot({ type: 'png', omitBackground: false });
    }

    // Measure real element size and resize viewport to fit exactly
    const box = await el.boundingBox();
    if (box) {
      const bodyPad = 48; // 24px left + 24px right from CSS
      await page.setViewportSize({
        width: Math.ceil(box.width + bodyPad + 4),
        height: Math.ceil(box.height + bodyPad + 4),
      });
    }

    // Screenshot the element directly — clean crop with no white border overflow
    return await el.screenshot({ type: 'png', omitBackground: false });
  } finally {
    await context.close();
  }
}
