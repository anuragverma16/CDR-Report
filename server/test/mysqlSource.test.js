import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const { buildSnapshot, deriveFields, callKey } = await import('../src/services/mysqlSource.js');
const { parseCdrFile } = await import('../src/services/parser.js');
const { normalizeRows, summarizeRecords } = await import('../src/services/ingest.js');

// Same layout as nexsahay_dialer: one call log with call_status, agent as name + JSON, start/answer/end stamps
const COLS = [['id', 'int'], ['call_to_number', 'varchar'], ['start_stamp', 'datetime'], ['answer_stamp', 'datetime'], ['end_stamp', 'datetime'], ['billsec', 'int'], ['duration', 'int'],
  ['answered_agent', 'varchar'], ['answered_agent_name', 'varchar'], ['answered_agent_number', 'varchar'], ['missed_agent', 'varchar'], ['call_status', 'varchar'], ['call_id', 'varchar'], ['created_at', 'timestamp']]
  .map(([name, type]) => ({ name, header: name, type }));
const row = (o) => ({ billsec: 0, answer_stamp: null, answered_agent: null, answered_agent_name: null, answered_agent_number: null, missed_agent: null, created_at: '2026-10-26 09:00:00', ...o });

test('MySQL snapshot: status from call_status, talk = end − answer, rows without agent left out, export fills hold/wrap/disposition', async () => {
  const tables = [
    { kind: 'answered', label: 'Answered', name: 'answered_calls', columns: COLS, rows: [
      row({ id: 1, call_to_number: '9876543210', start_stamp: '2026-10-26 10:15:00', answer_stamp: '2026-10-26 10:15:20', end_stamp: '2026-10-26 10:17:25', answered_agent_name: 'GAURI JAISWAL', answered_agent_number: 'Extension-0608439880008', call_status: 'answered', call_id: 'c-1', duration: 145 }),
      // same agent with a stray number on one call: must stay one agent under the usual extension
      row({ id: 3, call_to_number: '9876511111', start_stamp: '2026-10-26 09:00:00', answer_stamp: '2026-10-26 09:00:10', end_stamp: '2026-10-26 09:00:30', answered_agent_name: 'Gauri Jaiswal', answered_agent_number: '9217328984', call_status: 'answered', call_id: 'c-4', duration: 30 }),
      row({ id: 4, call_to_number: '9876522222', start_stamp: '2026-10-26 09:10:00', end_stamp: '2026-10-26 09:10:30', answered_agent_name: 'GAURI JAISWAL', answered_agent_number: 'Extension-0608439880008', call_status: 'missed', call_id: 'c-5', duration: 30 }),
      row({ id: 2, call_to_number: '9876500000', start_stamp: '2026-10-26 11:00:05', end_stamp: '2026-10-26 11:00:40', answered_agent: '[{"id":"05","name":"LAXMI MISHRA","number":"Extension-0608439880002"}]', call_status: 'missed', call_id: 'c-2', duration: 35 }),
    ] },
    { kind: 'missed', label: 'Missed', name: 'missed_calls', columns: COLS, rows: [
      row({ id: 1, call_to_number: '9000000000', start_stamp: null, end_stamp: '2026-10-26 12:54:14', call_status: null, call_id: 'c-3', duration: 2 }),
    ] },
  ];
  const headers = COLS.map((c) => c.header);
  const { mapping, derive, missing } = deriveFields(tables, headers);
  assert.deepEqual(missing, []);
  assert.deepEqual(derive.timeCols, ['start_stamp', 'answer_stamp', 'end_stamp']);
  assert.equal(derive.statusCol, 'call_status');
  assert.equal(tables[0].timeExpr, 'COALESCE(`start_stamp`, `answer_stamp`, `end_stamp`)');

  // Tata export for the day: only c-1 is in it (call IDs come with a leading tab in the CSV)
  const enrich = { byCallId: new Map([[callKey('	C-1'), { holdSec: 0, wrapSec: 7, disposition: 'not interested' }]]) };
  // dispositions table: c-2 has one (beats nothing), c-1 has one that wins over the export's
  const dbDisp = new Map([[callKey('c-2'), { name: 'CALL BACK', holdSec: 0, wrapSec: 12 }], [callKey('c-1'), { name: 'INTERESTED', holdSec: 5, wrapSec: 9 }]]);
  const snap = buildSnapshot(tables, headers, mapping, derive, enrich, dbDisp);
  // the missed_calls row has no agent anywhere: left out, only counted
  assert.deepEqual(snap.counts, { noAgent: 1, enriched: 1, dbDispositions: 2, answered: 4, missed: 0 });
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'snap-')), 'snap.csv');
  await fs.writeFile(file, snap.csv);
  const parsed = await parseCdrFile(file, 'csv');
  assert.equal(parsed.rows.length, 4);

  const classification = { status: { answered: ['answered'], missed: ['missed'] }, disposition: {} };
  const { records } = normalizeRows(parsed.rows, { mapping: snap.mapping, options: { dateOrder: 'YMD', durationFormat: 'auto' }, classification });
  assert.deepEqual(records.map((r) => r.statusClass), ['answered', 'answered', 'missed', 'missed']);
  assert.deepEqual(records.map((r) => r.agentName), ['Gauri Jaiswal (extension 0608439880008)', 'Gauri Jaiswal (extension 0608439880008)', 'Gauri Jaiswal (extension 0608439880008)', 'Laxmi Mishra (extension 0608439880002)']);
  assert.deepEqual(records.map((r) => r.talkSec), [125, 20, 0, 0]);
  // hold / wrap / disposition from the export where the call matched; unmatched stays blank (partial), never 0
  assert.deepEqual(records.map((r) => r.holdSec), [5, null, null, 0]);
  assert.deepEqual(records.map((r) => r.wrapSec), [9, null, null, 12]);
  assert.deepEqual(records.map((r) => r.dispositionLabel), ['interested', '', '', 'call back']);
  // without an export those report fields are not mapped at all (N/A)
  const bare = buildSnapshot(tables, headers, mapping, derive);
  assert.equal(bare.mapping.holdTime, null);
  assert.equal(bare.mapping.disposition, null);
  // database alone fills dispositions, hold and wrap-up
  const dbOnly = buildSnapshot(tables, headers, mapping, derive, null, dbDisp);
  assert.equal(dbOnly.mapping.disposition, 'Report Disposition');
  assert.equal(dbOnly.mapping.holdTime, 'Report Hold Seconds');
  assert.deepEqual(records.map((r) => r.reportDate), ['2026-10-26', '2026-10-26', '2026-10-26', '2026-10-26']);
  const s = summarizeRecords(records);
  assert.equal(s.valid, 4);
  assert.deepEqual(s.agents, ['Gauri Jaiswal (extension 0608439880008)', 'Laxmi Mishra (extension 0608439880002)']);
  assert.equal(s.invalid, 0);
});
