import crypto from 'node:crypto';
import { isBlank, normalizeAgent, normalizeLabel, parseDuration, parseTimestamp, localDate } from './normalize.js';
import { REQUIRED_FIELDS } from './mapping.js';

const DURATION_FIELDS = { talkTime: 'talkSec', holdTime: 'holdSec', wrapUpTime: 'wrapSec' };

export function validateMapping(mapping, headers) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (!mapping?.[f]) errors.push(`Required field "${f}" is not mapped to a column.`);
  }
  for (const [field, header] of Object.entries(mapping || {})) {
    if (header && !headers.includes(header)) errors.push(`Mapped column "${header}" (for ${field}) does not exist in this file.`);
  }
  const used = Object.values(mapping || {}).filter(Boolean);
  const dup = used.filter((h, i) => used.indexOf(h) !== i);
  if (dup.length) errors.push(`Column(s) mapped to more than one field: ${[...new Set(dup)].join(', ')}`);
  return errors;
}

function classifyStatus(label, classification) {
  if (!label) return 'unclassified';
  if (classification?.status?.answered?.includes(label)) return 'answered';
  if (classification?.status?.missed?.includes(label)) return 'missed';
  return 'unclassified';
}

function classifyDisposition(label, classification) {
  const out = [];
  if (!label) return out;
  for (const [cat, values] of Object.entries(classification?.disposition || {})) {
    if (values?.includes(label)) out.push(cat);
  }
  return out;
}

export function dedupeKeyFor(rec) {
  if (rec.callId) return { key: `id:${String(rec.callId).trim().toLowerCase()}`, basis: 'callId' };
  const parts = [rec.agentKey, rec.startAt ? rec.startAt.toISOString() : '', rec.phone || '', rec.talkSec ?? '', rec.statusLabel];
  return { key: `h:${crypto.createHash('sha1').update(parts.join('|')).digest('hex')}`, basis: 'composite' };
}

/**
 * Turn parsed rows into normalized CDR records.
 * Nothing is invented: unmapped fields are listed in `unmapped`, blank values stay null.
 */
export function normalizeRows(rows, { mapping, options = {}, classification, tz = 'Asia/Kolkata' }) {
  const unmapped = Object.keys(DURATION_FIELDS).filter((f) => !mapping[f]);
  if (!mapping.disposition) unmapped.push('disposition');
  const records = rows.map(({ rowNumber, values }) => {
    const errors = [];
    const warnings = [];
    const get = (f) => (mapping[f] ? values[mapping[f]] : undefined);

    const agent = normalizeAgent(get('agent'), options.agentAliases);
    if (!agent) errors.push('Agent name is blank');

    let startRaw = get('startTime');
    const dateRaw = get('startDate');
    // Date and time in separate columns: "2026-10-15" + "17:30:14" -> one value
    if (!isBlank(startRaw) && !isBlank(dateRaw) && /^\s*\d{1,2}:\d{2}(:\d{2})?\s*([AaPp][Mm])?\s*$/.test(String(startRaw))) {
      const datePart = dateRaw instanceof Date ? dateRaw.toISOString().slice(0, 10) : String(dateRaw).trim();
      startRaw = `${datePart} ${String(startRaw).trim()}`;
    }
    const startAt = parseTimestamp(startRaw, { dateOrder: options.dateOrder, tz });
    if (isBlank(startRaw)) errors.push('Call start time is blank');
    else if (!startAt) errors.push(`Unrecognized date/time "${startRaw}"`);

    const statusLabel = normalizeLabel(get('callStatus'));
    if (!statusLabel) errors.push('Call status is blank');
    const statusClass = classifyStatus(statusLabel, classification);

    const rec = {
      rowNumber,
      agentKey: agent?.key || '',
      agentName: agent?.name || '',
      callId: isBlank(get('callId')) ? null : String(get('callId')).trim(),
      phone: isBlank(get('phoneNumber')) ? null : String(get('phoneNumber')).replace(/\s+/g, ''),
      startAt,
      reportDate: startAt ? localDate(startAt, tz) : null,
      statusLabel,
      statusClass,
      dispositionLabel: mapping.disposition ? normalizeLabel(get('disposition')) : null,
      dispositionClasses: [],
      talkSec: null,
      holdSec: null,
      wrapSec: null,
      unmapped,
      missing: [],
    };
    if (mapping.callId && !rec.callId) rec.missing.push('callId');
    rec.dispositionClasses = classifyDisposition(rec.dispositionLabel, classification);
    if (mapping.disposition && !rec.dispositionLabel) rec.missing.push('disposition');

    for (const [field, prop] of Object.entries(DURATION_FIELDS)) {
      if (!mapping[field]) continue;
      const raw = get(field);
      const sec = parseDuration(raw, options.durationFormat);
      if (sec === null) rec.missing.push(field);
      else if (Number.isNaN(sec)) { rec.missing.push(field); warnings.push(`Unreadable ${field} "${raw}"`); }
      else rec[prop] = sec;
    }
    if (rec.statusClass === 'missed' && rec.talkSec > 0) warnings.push('Missed call has talk time > 0');
    if (rec.statusClass === 'answered' && mapping.talkTime && rec.talkSec === 0) warnings.push('Answered call has zero talk time');
    if (rec.statusClass === 'unclassified' && statusLabel) warnings.push(`Status "${statusLabel}" is not mapped to Answered or Missed`);

    rec.valid = errors.length === 0;
    rec.errors = errors;
    rec.warnings = warnings;
    const dk = dedupeKeyFor(rec);
    rec.dedupeKey = dk.key;
    rec.dedupeBasis = dk.basis;
    return rec;
  });
  return { records, unmapped };
}

/** Counts and distinct values used by the preview / validation screen. */
export function summarizeRecords(records, existingKeys = new Set()) {
  const seen = new Set();
  let valid = 0, invalid = 0, dupInFile = 0, dupExisting = 0;
  const statusCounts = new Map();
  const dispCounts = new Map();
  const dates = new Map();
  const invalidSamples = [];
  for (const r of records) {
    if (!r.valid) {
      invalid++;
      if (invalidSamples.length < 50) invalidSamples.push({ row: r.rowNumber, errors: r.errors });
      continue;
    }
    if (seen.has(r.dedupeKey)) { dupInFile++; continue; }
    seen.add(r.dedupeKey);
    if (existingKeys.has(r.dedupeKey)) { dupExisting++; continue; }
    valid++;
    statusCounts.set(r.statusLabel, (statusCounts.get(r.statusLabel) || 0) + 1);
    if (r.dispositionLabel) dispCounts.set(r.dispositionLabel, (dispCounts.get(r.dispositionLabel) || 0) + 1);
    dates.set(r.reportDate, (dates.get(r.reportDate) || 0) + 1);
  }
  const toList = (m) => [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  return {
    totalRows: records.length,
    valid,
    invalid,
    duplicatesInFile: dupInFile,
    duplicatesOfImported: dupExisting,
    usesCallId: records.some((r) => r.dedupeBasis === 'callId'),
    statuses: toList(statusCounts),
    dispositions: toList(dispCounts),
    dates: toList(dates).sort((a, b) => a.value.localeCompare(b.value)),
    invalidSamples,
    agents: [...new Set(records.filter((r) => r.valid).map((r) => r.agentName))].sort(),
  };
}
