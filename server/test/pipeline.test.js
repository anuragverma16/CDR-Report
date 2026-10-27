// Calculation tests for the CDR pipeline. Uses small synthetic fixtures written at test time;
// these fixtures exist only for testing and are never used by the application.
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseCdrFile } from '../src/services/parser.js';
import { suggestMapping, suggestClassification } from '../src/services/mapping.js';
import { normalizeRows, summarizeRecords, validateMapping } from '../src/services/ingest.js';
import { buildReport } from '../src/services/aggregator.js';
import { buildWorkbook } from '../src/services/excel.js';
import { parseDuration, formatDuration, parseTimestamp, localDate, normalizeAgent } from '../src/services/normalize.js';

const CSV = `Tata Dialer CDR Export
Call ID,Agent Name,Customer Number,Call Start Time,Call Status,Talk Time,Hold Time,Wrap Up Time,Disposition
C1,Rahul Sharma,9810000001,14/10/2026 09:15:10,Answered,00:05:00,00:00:30,00:00:20,Interested
C2,rahul.sharma,9810000002,14/10/2026 09:30:00,ANSWERED,120,0,10,Call Back
C3,Rahul  Sharma ,9810000003,14/10/2026 10:00:00,No Answer,0,0,0,
C4,Priya Verma,9810000004,14/10/2026 11:00:00,Answered,25:00:00,00:01:00,00:00:30,Not Interested
C5,Priya Verma,9810000005,14/10/2026 11:30:00,Busy,0,0,0,
C5,Priya Verma,9810000005,14/10/2026 11:30:00,Busy,0,0,0,
C6,,9810000006,14/10/2026 12:00:00,Answered,60,0,0,Answered
C7,Amit Kumar,9810000007,not a date,Answered,60,0,0,Answered
C8,Amit Kumar,9810000008,14/10/2026 13:00:00,Transferred,30,,5,Answered
C9,Amit Kumar,9810000009,15/10/2026 13:00:00,Answered,30,0,5,Interested
`;

async function fixture(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdr-test-'));
  const p = path.join(dir, name);
  await fs.writeFile(p, content);
  return p;
}

test('duration parsing handles HH:MM:SS, seconds, >24h and day fractions', () => {
  assert.equal(parseDuration('00:05:00'), 300);
  assert.equal(parseDuration('25:00:00'), 90000);
  assert.equal(parseDuration(120), 120);
  assert.equal(parseDuration('2:30'), 150);
  assert.equal(parseDuration(0.5), 43200);
  assert.equal(parseDuration(''), null);
  assert.ok(Number.isNaN(parseDuration('abc')));
  assert.equal(formatDuration(90061), '25:01:01');
  assert.equal(formatDuration(0), '00:00:00');
});

test('timestamps are interpreted in Asia/Kolkata and DMY by default', () => {
  const d = parseTimestamp('14/10/2026 23:30:00');
  assert.equal(d.toISOString(), '2026-10-14T18:00:00.000Z');
  assert.equal(localDate(d), '2026-10-14');
  assert.equal(parseTimestamp('10/14/2026 09:00', { dateOrder: 'MDY' }).toISOString(), '2026-10-14T03:30:00.000Z');
  assert.equal(parseTimestamp('14-Oct-2026 09:00 PM').toISOString(), '2026-10-14T15:30:00.000Z');
  assert.equal(parseTimestamp('31/02/2026 10:00'), null);
});

test('agent name variants collapse to one agent', () => {
  assert.equal(normalizeAgent('rahul.sharma').key, normalizeAgent(' Rahul  Sharma ').key);
  assert.equal(normalizeAgent('r sharma', { 'R Sharma': 'Rahul Sharma' }).name, 'Rahul Sharma');
});

test('end-to-end: parse → map → normalize → aggregate → reconcile', async () => {
  const p = await fixture('cdr.csv', CSV);
  const parsed = await parseCdrFile(p, 'csv');
  assert.equal(parsed.rows.length, 10);
  const { mapping } = suggestMapping(parsed.headers);
  assert.deepEqual(
    [mapping.agent, mapping.callStatus, mapping.startTime, mapping.callId, mapping.phoneNumber, mapping.talkTime, mapping.holdTime, mapping.wrapUpTime, mapping.disposition],
    ['Agent Name', 'Call Status', 'Call Start Time', 'Call ID', 'Customer Number', 'Talk Time', 'Hold Time', 'Wrap Up Time', 'Disposition'],
  );
  assert.deepEqual(validateMapping(mapping, parsed.headers), []);

  const pre = normalizeRows(parsed.rows, { mapping, options: { dateOrder: 'DMY' }, classification: {} });
  const sumPre = summarizeRecords(pre.records);
  const classification = suggestClassification(sumPre.statuses.map((s) => s.value), sumPre.dispositions.map((d) => d.value));
  assert.deepEqual(classification.status.answered.sort(), ['answered']);
  assert.deepEqual(classification.status.missed.sort(), ['busy', 'no answer']);
  assert.ok(!classification.status.answered.includes('transferred'));

  const { records } = normalizeRows(parsed.rows, { mapping, options: { dateOrder: 'DMY' }, classification });
  const summary = summarizeRecords(records);
  assert.equal(summary.invalid, 2);
  assert.equal(summary.duplicatesInFile, 1);
  assert.equal(summary.valid, 7);

  const recs = records.map((r) => ({ ...r, fileId: 'f1', raw: {} }));
  const report = buildReport({ records: recs, sources: [{ fileId: 'f1', name: 'cdr.csv' }], reportDate: '2026-10-14', dateFrom: '2026-10-14', dateTo: '2026-10-14', type: 'single' });
  const by = Object.fromEntries(report.agents.map((a) => [a.agent, a]));
  assert.equal(report.agents.length, 3);
  assert.equal(by['Rahul Sharma'].totalCalls, 3);
  assert.equal(by['Rahul Sharma'].answered, 2);
  assert.equal(by['Rahul Sharma'].missed, 1);
  assert.equal(by['Rahul Sharma'].talkSec, 420);
  assert.equal(by['Rahul Sharma'].interested, 1);
  assert.equal(by['Rahul Sharma'].callBack, 1);
  assert.equal(by['Priya Verma'].totalCalls, 2);
  assert.equal(by['Priya Verma'].talkSec, 90000);
  assert.equal(by['Amit Kumar'].totalCalls, 1);
  assert.equal(by['Amit Kumar'].unclassified, 1);
  assert.equal(report.total.totalCalls, 6);
  assert.equal(report.total.answered + report.total.missed + report.total.unclassified, 6);
  assert.equal(report.quality.outsideRange, 1);
  assert.equal(report.quality.duplicates.length, 1);
  assert.equal(report.quality.invalid.length, 2);
  assert.equal(report.availability.hold, 'partial');
  const failed = report.quality.reconciliation.filter((c) => !c.ok).map((c) => c.check);
  assert.deepEqual(failed, ['All call statuses mapped to Answered/Missed']);

  // Cross-file duplicate: same file imported twice must not double count
  const second = records.map((r) => ({ ...r, fileId: 'f2', raw: {} }));
  const combined = buildReport({ records: [...recs, ...second], sources: [{ fileId: 'f1', name: 'a.csv' }, { fileId: 'f2', name: 'b.csv' }], reportDate: '2026-10-14', dateFrom: '2026-10-14', dateTo: '2026-10-14', type: 'combined' });
  assert.equal(combined.total.totalCalls, 6);
  assert.equal(combined.sources[1].counted, 0);

  // Excel workbook has 4 sheets and duration cells are numeric [h]:mm:ss
  const buf = await buildWorkbook(report, recs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Agent Report', 'Overall Summary', 'Raw CDR', 'Data Quality']);
  const ws = wb.getWorksheet('Agent Report');
  const priyaRow = [5, 6, 7].find((r) => ws.getCell(r, 1).value === 'Priya Verma');
  assert.equal(ws.getCell(priyaRow, 5).numFmt, '[hh]:mm:ss');
  const v = ws.getCell(priyaRow, 5).value; // ExcelJS reads time-formatted numbers back as Dates
  assert.equal(v instanceof Date ? parseDuration(v) : Math.round(v * 86400), 90000);
  assert.equal(ws.getCell(8, 1).value, 'TOTAL');
  assert.equal(ws.getCell(8, 2).value, 6);
});

test('hold/wrap columns absent → N/A availability, never zero-filled', () => {
  const rows = [{ rowNumber: 2, values: { A: 'X', S: 'answered', T: '14/10/2026 10:00' } }];
  const mapping = { agent: 'A', callStatus: 'S', startTime: 'T' };
  const { records } = normalizeRows(rows, { mapping, classification: { status: { answered: ['answered'], missed: [] } } });
  const r = buildReport({ records: records.map((x) => ({ ...x, fileId: 'f' })), sources: [{ fileId: 'f', name: 'f' }], reportDate: '2026-10-14', type: 'single' });
  assert.equal(r.availability.hold, 'none');
  assert.equal(r.availability.wrap, 'none');
  assert.equal(r.summary.holdSec, null);
  assert.ok(r.notes.some((n) => n.includes('Hold Time shows N/A')));
});
