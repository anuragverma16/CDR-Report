import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Dash-only cells ("-", "---", "—") are the dialer's "no value recorded" placeholder, not data. */
export function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && /^[\s\-–—]*$/.test(v)) || (typeof v === 'number' && Number.isNaN(v));
}

/** Lower-cased, whitespace-collapsed label used for matching statuses / dispositions. */
export function normalizeLabel(v) {
  if (isBlank(v)) return '';
  return String(v).replace(/[ \s]+/g, ' ').trim().toLowerCase();
}

function titleCase(s) {
  return s.replace(/\S+/g, (w) => (w.length <= 3 && /^[A-Z]+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
}

/** Key used to group agent-name variants: case, dots, underscores, hyphens and extra spaces are ignored. */
export function agentKey(v) {
  if (isBlank(v)) return '';
  // Strip trailing phone numbers in parentheses, e.g. "KOMAL (+919240215065)" → "KOMAL"
  const cleaned = String(v).replace(/^["']|["']$/g, '').replace(/\s*\(\+?\d{7,15}\)\s*$/, '').trim();
  return cleaned.toLowerCase().replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize an agent name. `aliases` maps a variant (any spelling) to a canonical display name.
 * Returns { key, name } or null when the value is blank.
 */
export function normalizeAgent(v, aliases = {}) {
  const key = agentKey(v);
  if (!key) return null;
  for (const [variant, canonical] of Object.entries(aliases || {})) {
    if (agentKey(variant) === key && !isBlank(canonical)) {
      return { key: agentKey(canonical), name: String(canonical).trim() };
    }
  }
  return { key, name: titleCase(key) };
}

function wallClockToInstant(y, mo, d, h = 0, mi = 0, s = 0, tz) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const str = `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
  const parsed = dayjs.tz(str, tz);
  if (!parsed.isValid() || parsed.date() !== d || parsed.month() + 1 !== mo) return null;
  return parsed.toDate();
}

/**
 * Parse a CDR timestamp. Naive (zone-less) values are interpreted in `tz`.
 * Excel date cells arrive as JS Dates whose UTC fields hold the wall-clock time.
 * dateOrder: 'DMY' | 'MDY' | 'YMD' — only used for ambiguous numeric dates like 03/04/2026.
 */
export function parseTimestamp(v, { dateOrder = 'DMY', tz = 'Asia/Kolkata' } = {}) {
  if (isBlank(v)) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return wallClockToInstant(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds(), tz);
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      // Excel serial date number
      const d = new Date(Math.round(EXCEL_EPOCH_MS + v * 86400000));
      return parseTimestamp(d, { dateOrder, tz });
    }
    if (v > 1e9 && v < 1e10) return new Date(v * 1000); // unix seconds
    if (v > 1e12 && v < 1e13) return new Date(v); // unix ms
    return null;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseTimestamp(Number(s), { dateOrder, tz });

  const time = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?\s*$/);
  let h = 0, mi = 0, sec = 0;
  let datePart = s;
  if (time) {
    h = Number(time[1]); mi = Number(time[2]); sec = Number(time[3] || 0);
    const ap = time[4]?.toLowerCase();
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === 'pm' && h !== 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    }
    datePart = s.slice(0, time.index).replace(/[T,\s]+$/i, '').trim();
  }
  // 14-Oct-2026 / 14 Oct 2026 / Oct 14, 2026
  let m = datePart.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase().slice(0, 3)]) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
    return wallClockToInstant(fullYear(m[3]), mo, Number(m[1]), h, mi, sec, tz);
  }
  m = datePart.match(/^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})$/);
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)]) {
    return wallClockToInstant(fullYear(m[3]), MONTHS[m[1].toLowerCase().slice(0, 3)], Number(m[2]), h, mi, sec, tz);
  }
  m = datePart.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]];
  if (a.length === 4) return wallClockToInstant(Number(a), Number(b), Number(c), h, mi, sec, tz);
  if (c.length !== 4 && c.length !== 2) return null;
  const y = fullYear(c);
  if (dateOrder === 'MDY') return wallClockToInstant(y, Number(a), Number(b), h, mi, sec, tz);
  return wallClockToInstant(y, Number(b), Number(a), h, mi, sec, tz);
}

function fullYear(y) {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** YYYY-MM-DD of an instant in the given timezone. */
export function localDate(date, tz = 'Asia/Kolkata') {
  return dayjs(date).tz(tz).format('YYYY-MM-DD');
}

/**
 * Parse a duration into whole seconds.
 * Returns null for blank input and NaN for an unparseable value.
 * format: 'auto' | 'seconds' | 'minutes' | 'hms'
 */
export function parseDuration(v, format = 'auto') {
  if (isBlank(v)) return null;
  if (v instanceof Date) {
    const ms = v.getTime() - EXCEL_EPOCH_MS;
    if (Number.isNaN(ms) || ms < 0) return NaN;
    return Math.round(ms / 1000);
  }
  if (typeof v === 'number') {
    if (v < 0) return NaN;
    if (format === 'minutes') return Math.round(v * 60);
    if (format === 'auto' && v > 0 && v < 1 && !Number.isInteger(v)) return Math.round(v * 86400); // Excel day fraction
    return Math.round(v);
  }
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return parseDuration(Number(s), format === 'hms' ? 'seconds' : format);
  let m = s.match(/^(?:(\d+)\s*d(?:ays?)?\s*)?(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  if (m) {
    const [d, h, mi, sec] = [Number(m[1] || 0), Number(m[2]), Number(m[3]), Number(m[4])];
    if (mi > 59 || sec > 59) return NaN;
    return d * 86400 + h * 3600 + mi * 60 + sec;
  }
  m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) {
    if (Number(m[2]) > 59) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  m = s.match(/^(?:(\d+)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:s|utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:s|onds?)?)?)?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return NaN;
}

/** HH:MM:SS with hours allowed to exceed 24. */
export function formatDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return 'N/A';
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Display string for a cell value (used for previews / raw sheet). */
export function displayValue(v) {
  if (isBlank(v)) return '';
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1901) return formatDuration(parseDuration(v));
    return v.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/ 00:00:00$/, '');
  }
  return String(v);
}
