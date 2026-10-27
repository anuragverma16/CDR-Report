import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { config, mysqlConfigured } from '../config.js';
import { UploadedCDR, CdrRecord, GeneratedReport, audit } from '../models/index.js';
import { suggestMapping, DEFAULT_OPTIONS } from './mapping.js';
import { handleUploads, previewFile, processFile } from './cdrService.js';
import { generateReport } from './reportService.js';
import { storagePath, writeStored } from './storage.js';
import { MAX_ROWS } from './parser.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Synthetic columns added to every fetched row; the report reads these, the raw columns stay for the Raw CDR sheet.
const AGENT_COL = 'Report Agent';
const TIME_COL = 'Report Call Time';
const STATUS_COL = 'Report Status';
const TALK_COL = 'Report Talk Seconds';
// The dialer tables record no hold, wrap-up or disposition; these come from the day's Tata Dialer export, matched by call ID
const HOLD_COL = 'Report Hold Seconds';
const WRAP_COL = 'Report Wrap Up Seconds';
const DISP_COL = 'Report Disposition';
const TABLE_COL = 'Source Table';
const KEY_COL = 'Call Key';
const TEMPORAL = new Set(['date', 'datetime', 'timestamp']);

let pool = null;
function getPool() {
  if (pool) return pool;
  const m = config.mysql;
  pool = mysql.createPool({
    host: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
    connectionLimit: 4, connectTimeout: 8000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  // TIMESTAMP columns are returned in the session zone; make that the report zone.
  const offset = dayjs().tz(config.timezone).format('Z');
  pool.pool.on('connection', (conn) => conn.query('SET time_zone = ?', [offset]));
  return pool;
}

export async function closeMysql() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

const cleanName = (s) => String(s).replace(/\s+/g, ' ').trim();

// Column lists change rarely: remember them for a few minutes instead of asking information_schema on every fetch
const COLUMN_CACHE_MS = 5 * 60 * 1000;
const columnCache = new Map();
async function describeTableCached(table) {
  const hit = columnCache.get(table);
  if (hit && Date.now() - hit.at < COLUMN_CACHE_MS) return hit.columns;
  const columns = await describeTable(table);
  columnCache.set(table, { at: Date.now(), columns });
  return columns;
}

async function describeTable(table) {
  const [cols] = await getPool().query(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [config.mysql.database, table],
  );
  if (!cols.length) throw httpError(422, `Table "${table}" was not found in database "${config.mysql.database}".`);
  return cols.map((c) => ({ name: c.name, header: cleanName(c.name), type: String(c.type).toLowerCase() }));
}

/**
 * Column layout shared by both tables and how each report field is derived from it.
 * Status comes from the row's own status column when there is one (the "answered" table of this
 * dialer also holds missed calls); the table name is only the fallback.
 */
async function layout() {
  const tables = [
    { kind: 'answered', label: 'Answered', name: config.mysql.answeredTable },
    { kind: 'missed', label: 'Missed', name: config.mysql.missedTable },
  ];
  for (const t of tables) t.columns = await describeTableCached(t.name);
  const headers = [];
  const seen = new Set();
  for (const t of tables) for (const c of t.columns) {
    if (seen.has(c.header.toLowerCase())) continue;
    seen.add(c.header.toLowerCase());
    headers.push(c.header);
  }
  return { tables, headers, ...deriveFields(tables, headers) };
}

/** Pure part of layout(): which columns feed agent, time, status and talk time. */
export function deriveFields(tables, headers) {
  const { mapping } = suggestMapping(headers);
  const temporal = new Set(tables.flatMap((t) => t.columns.filter((c) => TEMPORAL.has(c.type)).map((c) => c.header)));
  const named = (re) => headers.filter((h) => temporal.has(h) && re.test(h));

  // Call time: first filled of start / answer / end (a call that never connected may have no start time)
  let timeCols = config.mysql.timeColumn ? config.mysql.timeColumn.split(',').map(cleanName).filter(Boolean) : [...new Set([...named(/(^|[^a-z])start/i), ...named(/answer/i), ...named(/(^|[^a-z])end/i)])];
  if (!timeCols.length && mapping.startTime) timeCols = [mapping.startTime];
  const agentPrimary = config.mysql.agentColumn ? cleanName(config.mysql.agentColumn) : mapping.agent;
  const agentFallbacks = headers.filter((h) => /agent/i.test(h) && h !== agentPrimary).sort((x, y) => /name/i.test(y) - /name/i.test(x));
  const derive = {
    agentPrimary,
    agentFallbacks,
    timeCols,
    statusCol: mapping.callStatus,
    agentNumberCol: headers.find((h) => /agent/i.test(h) && /number|extension/i.test(h)) || null,
    answerCol: named(/answer/i)[0] || null,
    endCol: named(/(^|[^a-z])end/i)[0] || null,
    talkFallback: mapping.talkTime,
  };

  const missing = [];
  if (!agentPrimary && !agentFallbacks.length) missing.push('agent name (set MYSQL_AGENT_COLUMN)');
  if (!timeCols.length || timeCols.some((h) => !headers.includes(h))) missing.push('call time (set MYSQL_TIME_COLUMN)');
  // Filter the day inside MySQL on the same time columns, when they are real DATE/DATETIME/TIMESTAMP columns
  for (const t of tables) {
    const cols = timeCols.map((h) => t.columns.find((c) => c.header === h)).filter((c) => c && TEMPORAL.has(c.type)).map((c) => mysql.escapeId(c.name));
    t.timeExpr = cols.length > 1 ? `COALESCE(${cols.join(', ')})` : cols[0] || null;
  }
  return { mapping, derive, missing };
}

/** Human-readable "report field <- column" list for the UI. */
function describeDerivation(mapping, derive) {
  return Object.fromEntries(Object.entries({
    agent: [derive.agentPrimary, ...derive.agentFallbacks.slice(0, 1)].filter(Boolean).join(' / '),
    startTime: derive.timeCols.join(' / '),
    callStatus: derive.statusCol || 'table name',
    talkTime: derive.answerCol && derive.endCol ? `${derive.endCol} − ${derive.answerCol}` : derive.talkFallback,
    callId: mapping.callId,
    phoneNumber: mapping.phoneNumber,
    disposition: `${config.mysql.dispositionsTable} (by call ID)`,
    holdTime: `${config.mysql.dispositionsTable}.hold_time`,
    wrapUpTime: `${config.mysql.dispositionsTable}.wrap_up_time`,
  }).filter(([, v]) => v));
}

export async function mysqlStatus() {
  const m = config.mysql;
  const base = { configured: mysqlConfigured(), connected: false, host: m.host ? `${m.host}:${m.port}` : null, database: m.database || null, tables: [], mapping: null, missing: [] };
  if (!base.configured) return { ...base, message: 'Set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD and MYSQL_DATABASE in server/.env, then restart the server.' };
  try {
    const { tables, mapping, derive, missing } = await layout();
    const db = getPool();
    const out = [];
    for (const t of tables) {
      const id = mysql.escapeId(t.name);
      const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${id}`);
      let latest = null;
      if (t.timeExpr) [[{ latest }]] = await db.query(`SELECT MAX(${t.timeExpr}) AS latest FROM ${id}`);
      out.push({ kind: t.kind, name: t.name, rows: Number(n), latest, dateColumn: t.timeExpr ? derive.timeCols.join(' / ') : null, columns: t.columns.map((c) => c.name) });
    }
    return { ...base, connected: true, tables: out, mapping: describeDerivation(mapping, derive), missing };
  } catch (e) {
    return { ...base, message: e.status ? e.message : `Could not connect to MySQL: ${e.message}` };
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) v = v.toString('utf8');
  else if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v).replace(/\r?\n/g, ' ');
  return /[",;\t|]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Per-stage timings of one fetch, written to the server log so slow steps are visible. */
function stageTimer(label) {
  let last = Date.now();
  return (step) => { const now = Date.now(); console.log(`[fetch ${label}] ${step} ${((now - last) / 1000).toFixed(2)}s`); last = now; };
}

async function fetchRows(date, enrich) {
  const mark = stageTimer(`${date} rows`);
  const { tables, headers, mapping, derive, missing } = await layout();
  mark('layout');
  if (missing.length) throw httpError(422, `These report columns could not be found in ${tables.map((t) => t.name).join(' / ')}: ${missing.join(', ')}. Columns available: ${headers.join(', ')}.`);
  const next = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
  // Answered and missed tables are read at the same time (independent queries)
  await Promise.all(tables.map(async (t) => {
    const where = t.timeExpr ? `WHERE ${t.timeExpr} >= ? AND ${t.timeExpr} < ?` : '';
    const [rows] = await getPool().query({ sql: `SELECT * FROM ${mysql.escapeId(t.name)} ${where} LIMIT ${MAX_ROWS + 1}`, timeout: 60000 }, [date, next]);
    if (rows.length > MAX_ROWS) throw httpError(422, `${t.name} returned more than ${MAX_ROWS} rows for ${date}. Raise MAX_ROWS_PER_FILE or narrow the data.`);
    t.rows = rows;
  }));
  const ids = tables.flatMap((t) => t.rows.map((r) => r[t.columns.find((c) => c.header === mapping.callId)?.name])).filter((v) => !blank(v));
  mark('calls query');
  const dbDispositions = await loadDbDispositions(ids);
  mark('dispositions query');
  const snapshot = buildSnapshot(tables, headers, mapping, derive, enrich, dbDispositions);
  mark('snapshot csv');
  return { ...snapshot, filteredInSql: tables.every((t) => t.timeExpr), tables: tables.map((t) => t.name) };
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Disposition, hold and wrap-up per call from the dispositions table (one row per dispositioned call, filled by the
 * dialer webhook). Its `disposition` column is written as "[object Object]", so the name is read from `raw_payload`
 * ({ disposition: { name, code } }); a readable plain column value is used as fallback.
 * hold_time / wrap_up_time are taken as stored (seconds).
 */
async function loadDbDispositions(callIds) {
  const table = config.mysql.dispositionsTable;
  const out = new Map();
  if (!table || !callIds.length) return out;
  const [[exists]] = await getPool().query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [config.mysql.database, table]);
  if (!exists.n) return out;
  // One round trip per 5000 IDs: each query to the database costs a network round trip, so fewer is faster
  for (let i = 0; i < callIds.length; i += 5000) {
    const [rows] = await getPool().query(`SELECT * FROM ${mysql.escapeId(table)} WHERE call_id IN (?) ORDER BY id`, [callIds.slice(i, i + 5000)]);
    for (const r of rows) { // ordered by id: a later re-disposition of the same call wins
      const secs = (v) => (blank(v) || !Number.isFinite(Number(v)) ? null : Number(v));
      out.set(callKey(r.call_id), { name: dispositionName(r), holdSec: secs(r.hold_time), wrapSec: secs(r.wrap_up_time) });
    }
  }
  return out;
}

function dispositionName(row) {
  let p = row.raw_payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const d = p?.disposition;
  const fromPayload = typeof d === 'string' ? d : d?.name || d?.code;
  if (!blank(fromPayload)) return String(fromPayload).trim();
  const plain = row.disposition;
  return blank(plain) || /^\[object \w+\]$/.test(String(plain).trim()) ? null : String(plain).trim();
}

/** Use disposition fields already present on answered_calls / missed_calls when the webhook row is absent. */
function sourceDispositionName(primary, secondary) {
  for (const value of [primary, secondary]) {
    if (blank(value)) continue;
    const text = String(value).trim();
    if (/^\[object \w+\]$/.test(text)) continue;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        const name = typeof parsed === 'string' ? parsed : parsed?.name || parsed?.code;
        if (!blank(name)) return String(name).trim();
      } catch { /* fall through to the next source field */ }
      continue;
    }
    return text;
  }
  return null;
}

/** Agent display name from a plain name or a dialer JSON blob like [{"name":"GAURI JAISWAL",...}]. */
function agentName(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (/^[[{]/.test(s)) {
    try {
      const j = JSON.parse(s);
      const first = Array.isArray(j) ? j[0] : j;
      return blank(first?.name) ? null : String(first.name).trim();
    } catch { return null; } // truncated JSON
  }
  return /^[\d\s+-]+$/.test(s) ? null : s;
}

/** Agent extension from "Extension-0608439880008" or the JSON blob's "number" field. */
function agentExtension(v) {
  if (blank(v)) return null;
  let s = String(v).trim();
  if (/^[[{]/.test(s)) {
    try { const j = JSON.parse(s); s = String((Array.isArray(j) ? j[0] : j)?.number ?? ''); } catch { return null; }
  }
  const digits = s.replace(/^extension[-\s:]*/i, '').trim();
  return /^\d{3,20}$/.test(digits) ? digits : null;
}

export const callKey = (v) => (blank(v) ? '' : String(v).replace(/[\s"']/g, '').toLowerCase());

/** Seconds between two "YYYY-MM-DD HH:MM:SS" wall-clock values of the same zone. */
function secondsBetween(from, to) {
  const ms = Date.parse(`${String(to).replace(' ', 'T')}Z`) - Date.parse(`${String(from).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/**
 * Rows of both tables -> one CSV in the upload format, plus the report mapping for it.
 * `enrich` (optional) = { byCallId: Map(callKey -> { holdSec, wrapSec, disposition }) } from the Tata export.
 * `dbDispositions` (optional) = Map(callKey -> { name, holdSec, wrapSec }) from the database; it wins over the export.
 */
export function buildSnapshot(tables, headers, mapping, derive, enrich = null, dbDispositions = null) {
  const counts = { noAgent: 0, enriched: 0, dbDispositions: 0 };
  const lines = [];
  const withKey = Boolean(mapping.callId);
  const dispositionCol = headers.find((h) => h.toLowerCase() === 'disposition') || mapping.disposition;
  const subDispositionCol = headers.find((h) => /^(sub_?disposition|disposition_sub)$/.test(h.toLowerCase())) || null;
  const agentOf = (t, r) => {
    const byHeader = new Map(t.columns.map((c) => [c.header, c.name]));
    const get = (h) => (h && byHeader.has(h) ? r[byHeader.get(h)] : null);
    const name = agentName(get(derive.agentPrimary)) || derive.agentFallbacks.map((h) => agentName(get(h))).find(Boolean);
    const ext = agentExtension(get(derive.agentNumberCol)) || derive.agentFallbacks.map((h) => agentExtension(get(h))).find(Boolean);
    return { name, ext };
  };
  // One label per agent: the extension seen most often for that name, so a stray number does not split the agent
  const extCounts = new Map();
  for (const t of tables) for (const r of t.rows) {
    const { name, ext } = agentOf(t, r);
    if (!name || !ext) continue;
    const k = name.toLowerCase();
    if (!extCounts.has(k)) extCounts.set(k, new Map());
    extCounts.get(k).set(ext, (extCounts.get(k).get(ext) || 0) + 1);
  }
  const mainExt = new Map([...extCounts].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]]));
  for (const t of tables) {
    counts[t.kind] = 0;
    const byHeader = new Map(t.columns.map((c) => [c.header, c.name]));
    const get = (r, h) => (h && byHeader.has(h) ? r[byHeader.get(h)] : null);
    for (const r of t.rows) {
      const cells = headers.map((h) => get(r, h));
      const { name } = agentOf(t, r);
      const ext = name && mainExt.get(name.toLowerCase());
      const agent = name && ext ? `${name} (extension ${ext})` : name;
      // calls with no agent at all are left out of the agent report (counted only in noAgent)
      if (!agent) { counts.noAgent++; continue; }
      counts[t.kind]++;
      const time = derive.timeCols.map((h) => get(r, h)).find((v) => !blank(v)) ?? null;
      const status = blank(get(r, derive.statusCol)) ? t.label : String(get(r, derive.statusCol)).trim();
      const answeredAt = get(r, derive.answerCol);
      const endedAt = get(r, derive.endCol);
      const talk = !blank(answeredAt) && !blank(endedAt) ? secondsBetween(answeredAt, endedAt) : get(r, derive.talkFallback);
      // unmatched calls keep these blank: the report marks the column partial (*) instead of inventing zeros
      const key = callKey(get(r, mapping.callId));
      const extra = enrich?.byCallId.get(key);
      if (extra) counts.enriched++;
      const db = dbDispositions?.get(key);
      if (db) counts.dbDispositions++;
      const sourceDisposition = sourceDispositionName(get(r, dispositionCol), get(r, subDispositionCol));
      cells.push(
        agent, time, status, talk,
        db?.holdSec ?? extra?.holdSec ?? get(r, mapping.holdTime),
        db?.wrapSec ?? extra?.wrapSec ?? get(r, mapping.wrapUpTime),
        db?.name ?? extra?.disposition ?? sourceDisposition,
        t.name,
      );
      // ids are only unique inside one table, so the dedupe key carries the table name
      if (withKey) { const id = get(r, mapping.callId); cells.push(blank(id) ? '' : `${t.name}#${id}`); }
      lines.push(cells.map(csvCell).join(','));
    }
  }
  const allHeaders = [...headers, AGENT_COL, TIME_COL, STATUS_COL, TALK_COL, HOLD_COL, WRAP_COL, DISP_COL, TABLE_COL, ...(withKey ? [KEY_COL] : [])];
  const enriched = counts.enriched > 0;
  const fromDb = counts.dbDispositions > 0;
  const hasDispositions = enriched || fromDb;
  const reportMapping = {
    ...mapping, agent: AGENT_COL, startTime: TIME_COL, startDate: null, callStatus: STATUS_COL, talkTime: TALK_COL,
    holdTime: hasDispositions ? HOLD_COL : null, wrapUpTime: hasDispositions ? WRAP_COL : null, disposition: hasDispositions ? DISP_COL : null,
    ...(withKey && { callId: KEY_COL }),
  };
  const csv = Buffer.from(`${[allHeaders.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, 'utf8');
  return { csv, counts, mapping: reportMapping };
}

/**
 * Latest processed Tata Dialer export that covers `date`: hold, wrap-up and disposition per call ID.
 * Returns null when none was uploaded for that day.
 */
export async function loadExportFor(date) {
  const file = await UploadedCDR.findOne({ source: { $ne: 'mysql' }, status: 'processed', 'dateRange.from': { $lte: date }, 'dateRange.to': { $gte: date } }).sort({ processedAt: -1 }).lean();
  if (!file || !file.mapping?.callId) return null;
  const recs = await CdrRecord.find({ fileId: file._id, valid: true, callId: { $ne: null } }).select('callId holdSec wrapSec dispositionLabel').lean();
  const byCallId = new Map(recs.map((r) => [callKey(r.callId), { holdSec: r.holdSec, wrapSec: r.wrapSec, disposition: r.dispositionLabel || null }]));
  return { file, byCallId, disposition: file.classification?.disposition || {} };
}

/** Remove older snapshots of the same day so repeated fetches do not pile up records. */
async function dropOlderSnapshots(date, keepId) {
  const old = await UploadedCDR.find({ source: 'mysql', sourceDate: date, _id: { $ne: keepId } }).lean();
  for (const f of old) {
    await CdrRecord.deleteMany({ fileId: f._id });
    await fs.unlink(storagePath('uploads', f.storedName)).catch(() => {});
    await UploadedCDR.deleteOne({ _id: f._id });
  }
}

// Fetches for the same date run one after another (never in parallel), and every request gets a fresh run,
// so a fetch asked for after an export upload always sees that export.
const queue = new Map();

/**
 * Pull the day's rows from MySQL right now and build the standard agent report from them.
 * Answered / Missed comes from each row's call status (the table name only when that is blank).
 */
export function fetchLiveReport({ date, user = null, trigger = 'manual' }) {
  if (!mysqlConfigured()) return Promise.reject(httpError(503, 'MySQL is not configured. Fill in the MYSQL_* settings in server/.env and restart the server.'));
  const previous = queue.get(date) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const actor = user || { id: null };
    const fetchedAt = new Date();
    const mark = stageTimer(date);
    let pulled;
    let enrich = null;
    try {
      enrich = await loadExportFor(date);
      mark('export lookup');
      pulled = await fetchRows(date, enrich);
      mark('mysql rows');
    } catch (e) {
      if (e.status) throw e;
      throw httpError(502, `MySQL query failed: ${e.message}`);
    }
    const { csv, counts, mapping, filteredInSql, tables } = pulled;
    if (counts.answered + counts.missed === 0) throw httpError(422, `No calls found in ${tables.join(' / ')} for ${date}.`);

    const sha256 = crypto.createHash('sha256').update(csv).digest('hex');
    let file = await UploadedCDR.findOne({ sha256, source: 'mysql', status: 'processed' }).sort({ processedAt: -1 });
    const reused = Boolean(file);
    let preview;
    if (!file) {
      const filename = await writeStored('uploads', 'csv', csv);
      const name = `MySQL ${config.mysql.database} ${date} (${dayjs(fetchedAt).tz(config.timezone).format('HH:mm:ss')}).csv`;
      const [up] = await handleUploads([{ path: storagePath('uploads', filename), filename, originalname: name, size: csv.length }], actor);
      if (up.error) throw httpError(422, up.error);
      await UploadedCDR.updateOne({ _id: up.file._id }, { source: 'mysql', sourceDate: date });
      const options = { ...DEFAULT_OPTIONS, dateOrder: 'YMD' };
      preview = await previewFile(up.file._id, { mapping, options });
      if (!preview.ok) throw httpError(422, preview.mappingErrors.join(' '));
      const st = preview.classification.status;
      // the table fallback labels are always classified, whatever other statuses the dialer uses
      const disposition = { ...preview.classification.disposition };
      // dispositions confirmed for the export file win over fresh suggestions
      for (const [cat, vals] of Object.entries(enrich?.disposition || {})) disposition[cat] = [...new Set([...(disposition[cat] || []), ...vals])];
      const classification = { status: { answered: [...new Set([...st.answered, 'answered'])], missed: [...new Set([...st.missed, 'missed'])] }, disposition };
      file = await processFile(up.file._id, { mapping, options, classification, reportDate: date }, actor);
    } else {
      preview = await previewFile(file._id, { mapping: file.mapping, options: file.options, classification: file.classification });
      file = file.toObject();
    }
    mark('upload, preview and save');
    await dropOlderSnapshots(date, file._id);
    mark('drop older snapshots');

    // Nothing changed since the last fetch: hand back that report instead of building an identical one
    const unchanged = reused && await GeneratedReport.findOne({ fileIds: [file._id], reportDate: date, type: 'single' }).sort({ createdAt: -1 });
    const report = unchanged || await generateReport({ type: 'single', fileIds: [file._id], reportDate: date, restrictToDate: true, userId: actor.id, trigger });
    mark(unchanged ? 'reused report' : 'report, excel and image');
    await audit(actor.id, 'mysql.fetch', String(report._id), { date, ...counts, reused, newReport: !unchanged });
    return {
      report: report.toObject(),
      reportDate: date,
      fetchedAt,
      fetched: { ...counts, filteredInSql, tables },
      export: enrich ? { name: enrich.file.originalName, calls: enrich.byCallId.size, matched: counts.enriched } : null,
      reused,
      stats: file.stats,
      unclassifiedStatuses: preview.unclassifiedStatuses || [],
      dates: (preview.summary?.dates || []).map((d) => d.value),
    };
  });
  queue.set(date, run);
  return run.finally(() => { if (queue.get(date) === run) queue.delete(date); });
}
