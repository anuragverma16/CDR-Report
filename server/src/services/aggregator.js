import { formatDuration } from './normalize.js';

const LIST_CAP = 5000;
const DURATION_METRICS = { talk: { prop: 'talkSec', field: 'talkTime', label: 'Actual Talk Time' }, hold: { prop: 'holdSec', field: 'holdTime', label: 'Hold Time' }, wrap: { prop: 'wrapSec', field: 'wrapUpTime', label: 'Wrap Up Time' } };
const DISP_CATS = ['interested', 'notInterested', 'callBack', 'answeredDisp'];

/** Column layout of the agent table. Sources without hold/wrap/dispositions can relabel or drop them. */
export const DEFAULT_LAYOUT = { holdLabel: 'Hold Time', wrapLabel: 'Wrap Up Time', dispositions: true };
export const layoutOf = (report) => ({ ...DEFAULT_LAYOUT, ...(report?.layout || {}) });

function emptyRow(name) {
  return { agent: name, totalCalls: 0, answered: 0, missed: 0, unclassified: 0, talkSec: 0, holdSec: 0, wrapSec: 0, interested: 0, notInterested: 0, callBack: 0, answeredDisp: 0, noDisposition: 0, warnings: 0 };
}

function pushCapped(arr, item, state, key) {
  if (arr.length < LIST_CAP) arr.push(item);
  else state[key] = true;
}

/**
 * Build the agent-wise report.
 * `records` must be ordered by import order (file upload time, then row). The first occurrence of a
 * dedupe key wins; later ones are listed as duplicates and never counted.
 * `sources` = [{ fileId, name }] for the files included.
 */
export function buildReport({ records, sources, reportDate, dateFrom, dateTo, type, agentFilter, layout: layoutIn }) {
  const layout = { ...DEFAULT_LAYOUT, ...(layoutIn || {}) };
  const labels = { talk: DURATION_METRICS.talk.label, hold: layout.holdLabel, wrap: layout.wrapLabel };
  const fileName = Object.fromEntries(sources.map((s) => [String(s.fileId), s.name]));
  const sourceStats = Object.fromEntries(sources.map((s) => [String(s.fileId), { fileId: String(s.fileId), name: s.name, rowsInRange: 0, counted: 0, duplicates: 0, invalid: 0 }]));
  const truncated = {};
  const quality = { invalid: [], duplicates: [], warnings: [], missingValues: {}, unmappedStatuses: {}, unmappedDispositions: {}, dispositionsOnMissed: 0, outsideRange: 0 };
  const firstSeen = new Map();
  const byAgent = new Map();
  const avail = { talk: { mapped: 0, unmapped: 0, missing: 0 }, hold: { mapped: 0, unmapped: 0, missing: 0 }, wrap: { mapped: 0, unmapped: 0, missing: 0 }, disposition: { mapped: 0, unmapped: 0, missing: 0 } };

  for (const r of records) {
    const fid = String(r.fileId);
    const st = sourceStats[fid];
    if (!r.valid) {
      st.invalid++;
      r._inc = 'Invalid';
      pushCapped(quality.invalid, { file: fileName[fid], row: r.rowNumber, errors: r.errors }, truncated, 'invalid');
      continue;
    }
    if ((dateFrom && r.reportDate < dateFrom) || (dateTo && r.reportDate > dateTo)) { quality.outsideRange++; r._inc = 'Outside date range'; continue; }
    if (agentFilter && agentFilter.length && !agentFilter.includes(r.agentName)) { r._inc = 'Filtered out'; continue; }
    st.rowsInRange++;
    const prev = firstSeen.get(r.dedupeKey);
    if (prev) {
      st.duplicates++;
      r._inc = 'Duplicate (not counted)';
      pushCapped(quality.duplicates, { file: fileName[fid], row: r.rowNumber, duplicateOfFile: fileName[prev.fileId], duplicateOfRow: prev.row, basis: r.dedupeBasis === 'callId' ? `Call ID ${r.callId}` : 'Same agent, time, number, talk time and status' }, truncated, 'duplicates');
      continue;
    }
    firstSeen.set(r.dedupeKey, { fileId: fid, row: r.rowNumber });
    st.counted++;
    r._inc = 'Counted';

    let row = byAgent.get(r.agentKey);
    if (!row) { row = emptyRow(r.agentName); byAgent.set(r.agentKey, row); }
    row.totalCalls++;
    row[r.statusClass === 'answered' ? 'answered' : r.statusClass === 'missed' ? 'missed' : 'unclassified']++;
    if (r.statusClass === 'unclassified') quality.unmappedStatuses[r.statusLabel] = (quality.unmappedStatuses[r.statusLabel] || 0) + 1;

    for (const [m, def] of Object.entries(DURATION_METRICS)) {
      if (r.unmapped?.includes(def.field)) { avail[m].unmapped++; continue; }
      avail[m].mapped++;
      if (r[def.prop] === null || r[def.prop] === undefined) avail[m].missing++;
      else row[def.prop] += r[def.prop];
    }
    if (r.unmapped?.includes('disposition')) avail.disposition.unmapped++;
    else {
      avail.disposition.mapped++;
      if (!r.dispositionLabel) {
        avail.disposition.missing++;
        if (r.statusClass === 'answered') row.noDisposition++;
      } else {
        for (const c of r.dispositionClasses || []) if (DISP_CATS.includes(c)) row[c]++;
        if (!r.dispositionClasses?.length) quality.unmappedDispositions[r.dispositionLabel] = (quality.unmappedDispositions[r.dispositionLabel] || 0) + 1;
        if (r.statusClass === 'missed') quality.dispositionsOnMissed++;
      }
    }
    for (const f of r.missing || []) quality.missingValues[f] = (quality.missingValues[f] || 0) + 1;
    if (r.warnings?.length) {
      row.warnings++;
      pushCapped(quality.warnings, { file: fileName[fid], row: r.rowNumber, agent: r.agentName, warnings: r.warnings }, truncated, 'warnings');
    }
  }

  const agents = [...byAgent.values()].sort((a, b) => b.totalCalls - a.totalCalls || a.agent.localeCompare(b.agent));
  const total = emptyRow('TOTAL');
  for (const a of agents) for (const k of Object.keys(total)) if (k !== 'agent') total[k] += a[k];

  const availability = {};
  for (const [m, v] of Object.entries(avail)) {
    availability[m] = v.mapped === 0 ? 'none' : v.unmapped > 0 || v.missing > 0 ? 'partial' : 'full';
  }

  const notes = [];
  for (const m of Object.keys(DURATION_METRICS)) {
    const label = labels[m];
    if (availability[m] === 'none') notes.push(`${label} shows N/A because no ${label.toLowerCase()} column was mapped in the source CDR file(s).`);
    else if (availability[m] === 'partial') {
      const parts = [
        avail[m].missing && `${avail[m].missing} call(s) have no value recorded`,
        avail[m].unmapped && `${avail[m].unmapped} call(s) come from files without this column`,
      ].filter(Boolean);
      notes.push(`${label} is partial: ${parts.join(' and ')}; those calls are left out of the total, not counted as 00:00:00.`);
    }
  }
  if (!layout.dispositions) { /* source has no dispositions; the columns are not shown at all */ }
  else if (availability.disposition === 'none') notes.push('Disposition columns show N/A because no disposition column was mapped.');
  else if (availability.disposition === 'partial') notes.push(`${avail.disposition.missing + avail.disposition.unmapped} counted call(s) have no disposition. Disposition columns only count calls whose disposition is mapped to that category; categories are not mutually exclusive.`);
  if (total.unclassified) notes.push(`${total.unclassified} call(s) have a status not mapped to Answered or Missed. They are in Total Calls but in neither Answered nor Missed.`);

  // Reconciliation
  const sum = (k) => agents.reduce((s, a) => s + a[k], 0);
  const counted = Object.values(sourceStats).reduce((s, x) => s + x.counted, 0);
  const reconciliation = [
    { check: 'Sum of agent Total Calls = TOTAL row', expected: total.totalCalls, actual: sum('totalCalls') },
    { check: 'TOTAL = Answered + Missed + Unclassified status', expected: total.totalCalls, actual: total.answered + total.missed + total.unclassified },
    { check: 'TOTAL = unique valid records counted from source files', expected: counted, actual: total.totalCalls },
    { check: 'Every agent: Total = Answered + Missed + Unclassified', expected: agents.length, actual: agents.filter((a) => a.totalCalls === a.answered + a.missed + a.unclassified).length },
  ].map((c) => ({ ...c, ok: c.expected === c.actual }));
  const unclassifiedOk = total.unclassified === 0;
  reconciliation.push({ check: 'All call statuses mapped to Answered/Missed', expected: 0, actual: total.unclassified, ok: unclassifiedOk });

  const rate = (n) => (total.totalCalls ? Math.round((n / total.totalCalls) * 10000) / 100 : null);
  const toList = (o) => Object.entries(o).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);

  return {
    title: 'Tata Dialer – Agent Report',
    type,
    reportDate,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    generatedAt: new Date().toISOString(),
    agents,
    total,
    availability,
    layout,
    notes,
    summary: {
      totalCalls: total.totalCalls,
      answered: total.answered,
      missed: total.missed,
      unclassified: total.unclassified,
      answerRate: rate(total.answered),
      missedRate: rate(total.missed),
      talkSec: availability.talk === 'none' ? null : total.talkSec,
      holdSec: availability.hold === 'none' ? null : total.holdSec,
      wrapSec: availability.wrap === 'none' ? null : total.wrapSec,
      interested: availability.disposition === 'none' ? null : total.interested,
      notInterested: availability.disposition === 'none' ? null : total.notInterested,
      callBack: availability.disposition === 'none' ? null : total.callBack,
      answeredDisp: availability.disposition === 'none' ? null : total.answeredDisp,
      agentCount: agents.length,
    },
    quality: {
      ...quality,
      unmappedStatuses: toList(quality.unmappedStatuses),
      unmappedDispositions: toList(quality.unmappedDispositions),
      reconciliation,
      truncated,
      allChecksPassed: reconciliation.every((c) => c.ok),
    },
    sources: Object.values(sourceStats),
  };
}

/** Values exactly as displayed in the HTML table, PNG and messages. */
export function displayRow(row, availability) {
  const dur = (m, v) => (availability[m] === 'none' ? 'N/A' : formatDuration(v) + (availability[m] === 'partial' ? '*' : ''));
  const disp = (v) => (availability.disposition === 'none' ? 'N/A' : String(v));
  return {
    agent: row.agent,
    totalCalls: String(row.totalCalls),
    answered: String(row.answered),
    missed: String(row.missed),
    talk: dur('talk', row.talkSec),
    hold: dur('hold', row.holdSec),
    wrap: dur('wrap', row.wrapSec),
    interested: disp(row.interested),
    notInterested: disp(row.notInterested),
    callBack: disp(row.callBack),
    answeredDisp: disp(row.answeredDisp),
  };
}
