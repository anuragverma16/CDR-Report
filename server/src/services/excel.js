import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { displayValue } from './normalize.js';
import { layoutOf } from './aggregator.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const COLORS = {
  navy: '203B68',
  blue: '3278B8',
  green: '218346',
  maroon: '68223F',
  blueSub: '4A8CC9',
  greenSub: '2E9A57',
  maroonSub: '84304F',
  rowAlt: 'DCE9F7',
  white: 'FFFFFF',
  talkGreen: '1B7A3E',
  yellow: 'FFF2B3',
  lightGreen: 'D8F0DC',
  border: 'B7C7DD',
};

const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });
const thin = { style: 'thin', color: { argb: `FF${COLORS.border}` } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const DUR_FMT = '[hh]:mm:ss'; // elapsed hours, so 25:00:00 stays 25:00:00
const secToDays = (s) => s / 86400;

const HEADERS = [
  { key: 'agent', label: 'Agent', width: 26 },
  { key: 'totalCalls', label: 'Total Calls', width: 12 },
  { key: 'answered', label: 'Answered', width: 12 },
  { key: 'missed', label: 'Missed', width: 11 },
  { key: 'talkSec', label: 'Actual Talk Time', width: 17, dur: 'talk' },
  { key: 'holdSec', label: 'Hold Time', width: 13, dur: 'hold' },
  { key: 'wrapSec', label: 'Wrap Up Time', width: 14, dur: 'wrap' },
  { key: 'interested', label: 'Interested', width: 12, disp: true },
  { key: 'notInterested', label: 'Not Interested', width: 15, disp: true },
  { key: 'callBack', label: 'Call Back', width: 12, disp: true },
  { key: 'answeredDisp', label: 'Answered (Disp)', width: 16, disp: true },
];

function formatGenerated(iso, tz) {
  return dayjs(iso).tz(tz).format('DD MMM YYYY, hh:mm:ss A') + ` (${tz})`;
}

/** Header list for this report: hold/wrap relabelled, disposition columns dropped when the source has none. */
function headersFor(report) {
  const layout = layoutOf(report);
  return HEADERS.filter((h) => layout.dispositions || !h.disp)
    .map((h) => (h.key === 'holdSec' ? { ...h, label: layout.holdLabel } : h.key === 'wrapSec' ? { ...h, label: layout.wrapLabel } : h));
}

function addAgentSheet(wb, report, tz) {
  const headers = headersFor(report);
  const cols = headers.length;
  const last = String.fromCharCode(64 + cols);
  const ws = wb.addWorksheet('Agent Report', { views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }], properties: { defaultRowHeight: 20 }, pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws.columns = headers.map((h) => ({ key: h.key, width: h.width }));

  ws.mergeCells(`A1:${last}1`);
  const t = ws.getCell('A1');
  t.value = `${report.title} | Date: ${report.reportDate}`;
  t.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  t.fill = fill(COLORS.navy);
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${last}2`);
  const g = ws.getCell('A2');
  const range = report.dateFrom && report.dateTo && report.dateFrom !== report.dateTo ? `Period: ${report.dateFrom} to ${report.dateTo} · ` : '';
  g.value = `${range}Generated: ${formatGenerated(report.generatedAt, tz)} · ${report.type === 'combined' ? 'Combined report' : 'Single file report'} · Sources: ${report.sources.map((s) => s.name).join(', ')}`;
  g.font = { italic: true, size: 9, color: { argb: 'FF4B5B73' } };
  g.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 28;

  const groups = [
    { range: 'A3:A4', label: 'Agent', color: COLORS.navy },
    { range: 'B3:D3', label: 'Call Volume', color: COLORS.blue },
    { range: 'E3:G3', label: 'Duration', color: COLORS.green },
    ...(cols > 7 ? [{ range: `H3:${last}3`, label: 'Dispositions', color: COLORS.maroon }] : []),
  ];
  for (const grp of groups) {
    ws.mergeCells(grp.range);
    const c = ws.getCell(grp.range.split(':')[0]);
    c.value = grp.label;
    c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(grp.color);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  ws.getRow(3).height = 24;
  const subColors = [null, COLORS.blueSub, COLORS.blueSub, COLORS.blueSub, COLORS.greenSub, COLORS.greenSub, COLORS.greenSub, COLORS.maroonSub, COLORS.maroonSub, COLORS.maroonSub, COLORS.maroonSub];
  headers.forEach((h, i) => {
    if (i === 0) return;
    const c = ws.getRow(4).getCell(i + 1);
    c.value = h.label;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(subColors[i]);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(4).height = 30;
  for (let r = 3; r <= 4; r++) for (let c = 1; c <= cols; c++) ws.getRow(r).getCell(c).border = border;

  const av = report.availability;
  const writeRow = (row, rowIdx, isTotal, alt) => {
    const xr = ws.getRow(rowIdx);
    headers.forEach((h, i) => {
      const c = xr.getCell(i + 1);
      let v = row[h.key];
      if (h.dur) {
        if (av[h.dur] === 'none') v = 'N/A';
        else { v = secToDays(v); c.numFmt = DUR_FMT; }
      } else if (h.disp && av.disposition === 'none') v = 'N/A';
      c.value = v;
      c.border = border;
      c.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle', indent: i === 0 ? 1 : 0 };
      if (isTotal) {
        c.fill = fill(COLORS.navy);
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        return;
      }
      c.fill = fill(alt ? COLORS.rowAlt : COLORS.white);
      c.font = { bold: i === 0, color: { argb: 'FF1F2937' } };
      if (h.key === 'talkSec' && v !== 'N/A') c.font = { bold: true, color: { argb: `FF${COLORS.talkGreen}` } };
      if (h.key === 'notInterested' || h.key === 'callBack') c.fill = fill(COLORS.yellow);
      if (h.key === 'answeredDisp') c.fill = fill(COLORS.lightGreen);
    });
    xr.height = 21;
  };
  report.agents.forEach((a, i) => writeRow(a, 5 + i, false, i % 2 === 0));
  const totalIdx = 5 + report.agents.length;
  writeRow(report.total, totalIdx, true, false);
  if (report.agents.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + report.agents.length, column: cols } };

  let n = totalIdx + 2;
  const notes = [...report.notes];
  if ([av.talk, av.hold, av.wrap].includes('partial')) notes.push('* marks a partial value: some counted calls had no value for this metric in the source.');
  if (!report.quality.allChecksPassed) notes.push('⚠ Some reconciliation checks did not pass — see the Data Quality sheet.');
  for (const note of notes) {
    ws.mergeCells(`A${n}:${last}${n}`);
    const c = ws.getCell(`A${n}`);
    c.value = note;
    c.font = { size: 9, italic: true, color: { argb: 'FF6B4E16' } };
    c.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(n).height = 26;
    n++;
  }
}

function sectionTitle(ws, rowIdx, text, color = COLORS.navy, span = 8) {
  ws.mergeCells(rowIdx, 1, rowIdx, span);
  const c = ws.getCell(rowIdx, 1);
  c.value = text;
  c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  c.fill = fill(color);
  c.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(rowIdx).height = 22;
}

function headerRow(ws, rowIdx, labels, color = COLORS.blue) {
  labels.forEach((l, i) => {
    const c = ws.getRow(rowIdx).getCell(i + 1);
    c.value = l;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(color);
    c.border = border;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
}

function dataRow(ws, rowIdx, values, alt) {
  values.forEach((v, i) => {
    const c = ws.getRow(rowIdx).getCell(i + 1);
    if (v && typeof v === 'object' && 'dur' in v) {
      if (v.dur === null) c.value = 'N/A';
      else { c.value = secToDays(v.dur); c.numFmt = DUR_FMT; }
    } else if (v && typeof v === 'object' && 'pct' in v) {
      c.value = v.pct === null ? 'N/A' : v.pct / 100;
      if (v.pct !== null) c.numFmt = '0.00%';
    } else c.value = v;
    c.border = border;
    c.fill = fill(alt ? COLORS.rowAlt : COLORS.white);
    c.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle', wrapText: true };
  });
}

function addSummarySheet(wb, report, tz) {
  const ws = wb.addWorksheet('Overall Summary', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws.columns = [{ width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 22 }, { width: 18 }];
  ws.mergeCells('A1:H1');
  const t = ws.getCell('A1');
  t.value = `Overall Summary | Date: ${report.reportDate}`;
  t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  t.fill = fill(COLORS.navy);
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;
  ws.getCell('A2').value = `Generated: ${formatGenerated(report.generatedAt, tz)}`;
  ws.getCell('A2').font = { italic: true, size: 9 };

  const s = report.summary;
  const av = report.availability;
  const layout = layoutOf(report);
  let r = 4;
  sectionTitle(ws, r++, 'Totals', COLORS.blue, 2);
  headerRow(ws, r++, ['Metric', 'Value'], COLORS.blueSub);
  const rows = [
    ['Total Calls', s.totalCalls],
    ['Answered Calls', s.answered],
    ['Missed Calls', s.missed],
    ['Calls with unmapped status', s.unclassified],
    ['Answer Rate (Answered ÷ Total Calls)', { pct: s.answerRate }],
    ['Missed-Call Rate (Missed ÷ Total Calls)', { pct: s.missedRate }],
    ['Total Actual Talk Time', { dur: av.talk === 'none' ? null : s.talkSec }],
    [`Total ${layout.holdLabel}`, { dur: av.hold === 'none' ? null : s.holdSec }],
    [`Total ${layout.wrapLabel}`, { dur: av.wrap === 'none' ? null : s.wrapSec }],
    ...(layout.dispositions ? [
      ['Interested', s.interested ?? 'N/A'],
      ['Not Interested', s.notInterested ?? 'N/A'],
      ['Call Back', s.callBack ?? 'N/A'],
      ['Answered (Disp)', s.answeredDisp ?? 'N/A'],
    ] : []),
    ['Number of Agents', s.agentCount],
  ];
  rows.forEach((row, i) => dataRow(ws, r++, row, i % 2 === 0));

  r += 1;
  sectionTitle(ws, r++, 'Agent Performance Comparison', COLORS.green, 8);
  headerRow(ws, r++, ['Agent', 'Total Calls', 'Answered', 'Missed', 'Answer Rate', 'Share of All Calls', 'Actual Talk Time', 'Avg Talk / Answered'], COLORS.greenSub);
  report.agents.forEach((a, i) => {
    const ansRate = a.totalCalls ? Math.round((a.answered / a.totalCalls) * 10000) / 100 : null;
    const share = s.totalCalls ? Math.round((a.totalCalls / s.totalCalls) * 10000) / 100 : null;
    const avg = av.talk === 'none' || !a.answered ? null : Math.round(a.talkSec / a.answered);
    dataRow(ws, r++, [a.agent, a.totalCalls, a.answered, a.missed, { pct: ansRate }, { pct: share }, { dur: av.talk === 'none' ? null : a.talkSec }, { dur: avg }], i % 2 === 0);
  });
  ws.getCell(r + 1, 1).value = 'Avg Talk / Answered = Actual Talk Time ÷ Answered calls (N/A when there are no answered calls or no talk-time column).';
  ws.getCell(r + 1, 1).font = { italic: true, size: 9 };
}

function addRawSheet(wb, report, rawRecords, fileNames) {
  const ws = wb.addWorksheet('Raw CDR', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [];
  for (const r of rawRecords) for (const h of Object.keys(r.raw || {})) if (!headers.includes(h)) headers.push(h);
  const meta = ['Source File', 'Source Row', 'Report Inclusion', 'Normalized Agent', 'Status Class', 'Dispositions Mapped', 'Report Date (IST)'];
  const all = [...meta, ...headers];
  ws.columns = all.map((h, i) => ({ header: h, width: i < meta.length ? 18 : Math.min(30, Math.max(12, h.length + 4)) }));
  ws.getRow(1).eachCell((c, i) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(i <= meta.length ? COLORS.navy : COLORS.blue);
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const r of rawRecords) {
    ws.addRow([
      fileNames[String(r.fileId)] || '',
      r.rowNumber,
      r._inc || 'Not evaluated',
      r.agentName,
      r.statusClass,
      (r.dispositionClasses || []).join(', '),
      r.reportDate || '',
      ...headers.map((h) => {
        const v = r.raw?.[h];
        return v instanceof Date ? displayValue(v) : v ?? null;
      }),
    ]);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: all.length } };
}

function addQualitySheet(wb, report) {
  const ws = wb.addWorksheet('Data Quality', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws.columns = [{ width: 46 }, { width: 18 }, { width: 18 }, { width: 50 }, { width: 18 }];
  const q = report.quality;
  let r = 1;
  sectionTitle(ws, r++, `Reconciliation — ${q.allChecksPassed ? 'all checks passed' : 'ATTENTION: some checks failed'}`, q.allChecksPassed ? COLORS.green : COLORS.maroon, 5);
  headerRow(ws, r++, ['Check', 'Expected', 'Actual', 'Result'], COLORS.blueSub);
  q.reconciliation.forEach((c, i) => {
    dataRow(ws, r, [c.check, c.expected, c.actual, c.ok ? 'PASS' : 'FAIL'], i % 2 === 0);
    ws.getCell(r, 4).font = { bold: true, color: { argb: c.ok ? 'FF1B7A3E' : 'FFB42318' } };
    r++;
  });

  r++;
  sectionTitle(ws, r++, 'Source Files', COLORS.navy, 5);
  headerRow(ws, r++, ['File', 'Rows in range', 'Counted', 'Duplicates skipped', 'Invalid rows'], COLORS.blueSub);
  report.sources.forEach((s, i) => dataRow(ws, r++, [s.name, s.rowsInRange, s.counted, s.duplicates, s.invalid], i % 2 === 0));
  if (q.outsideRange) { ws.getCell(r, 1).value = `${q.outsideRange} valid record(s) were outside the report period and excluded.`; r++; }

  const listSection = (title, cols, items, map, color, truncKey) => {
    r++;
    sectionTitle(ws, r++, `${title} (${items.length}${truncKey && q.truncated?.[truncKey] ? '+ (list capped)' : ''})`, color, 5);
    if (!items.length) { ws.getCell(r++, 1).value = 'None'; return; }
    headerRow(ws, r++, cols, COLORS.blueSub);
    items.forEach((it, i) => dataRow(ws, r++, map(it), i % 2 === 0));
  };
  listSection('Invalid Rows', ['File', 'Row', '', 'Errors'], q.invalid, (x) => [x.file, x.row, '', x.errors.join('; ')], COLORS.maroon, 'invalid');
  listSection('Duplicate Records', ['File', 'Row', 'Duplicate of row', 'Duplicate of file / basis'], q.duplicates, (x) => [x.file, x.row, x.duplicateOfRow, `${x.duplicateOfFile} — ${x.basis}`], COLORS.maroon, 'duplicates');
  listSection('Missing Values', ['Field', 'Counted calls with blank value'], Object.entries(q.missingValues), ([f, n]) => [f, n], COLORS.blue);
  listSection('Unmapped Call Statuses', ['Status value', 'Calls'], q.unmappedStatuses, (x) => [x.value, x.count], COLORS.blue);
  listSection('Unmapped Dispositions', ['Disposition value', 'Calls'], q.unmappedDispositions, (x) => [x.value, x.count], COLORS.blue);
  listSection('Record Warnings', ['File', 'Row', 'Agent', 'Warnings'], q.warnings, (x) => [x.file, x.row, x.agent, x.warnings.join('; ')], COLORS.green, 'warnings');
  if (q.dispositionsOnMissed) { r++; ws.getCell(r++, 1).value = `${q.dispositionsOnMissed} missed call(s) carry a disposition (counted in disposition columns as recorded).`; }
}

/** Build the 4-sheet workbook. Same `report` object is used for the PNG image. */
export async function buildWorkbook(report, rawRecords, { tz = 'Asia/Kolkata' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tata Dialer CDR Report System';
  wb.created = new Date(report.generatedAt);
  addAgentSheet(wb, report, tz);
  addSummarySheet(wb, report, tz);
  addRawSheet(wb, report, rawRecords, Object.fromEntries(report.sources.map((s) => [s.fileId, s.name])));
  addQualitySheet(wb, report);
  return wb.xlsx.writeBuffer();
}
