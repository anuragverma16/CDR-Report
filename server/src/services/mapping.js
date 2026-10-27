/**
 * Report fields a CDR column can be mapped to. Keyword lists only drive *suggestions*;
 * the user always confirms or changes the mapping in the UI.
 */
export const REPORT_FIELDS = [
  { key: 'agent', label: 'Agent name', required: true, keywords: ['agent name', 'agent', 'agent id', 'user name', 'username', 'executive', 'caller name', 'user'] },
  { key: 'callStatus', label: 'Call status', required: true, keywords: ['call status', 'status', 'call result', 'call state', 'hangup status'] },
  { key: 'startTime', label: 'Call start date/time', required: true, keywords: ['start time', 'call start time', 'start date time', 'call start', 'call date time', 'date time', 'datetime', 'call time', 'start date', 'call date', 'date', 'time'] },
  // Optional: for files that split date and time into two columns. Combined with a time-only startTime.
  { key: 'startDate', label: 'Call start date (if separate from time)', required: false, keywords: ['call start date', 'start date'] },
  { key: 'callId', label: 'Unique call ID', required: false, keywords: ['call id', 'callid', 'unique id', 'uniqueid', 'uuid', 'call uuid', 'cdr id', 'call ref id', 'id'] },
  { key: 'phoneNumber', label: 'Customer number', required: false, keywords: ['customer number', 'customer phone', 'phone number', 'mobile number', 'mobile', 'phone', 'destination number', 'dialed number', 'number', 'customer'] },
  { key: 'talkTime', label: 'Talk time', required: false, keywords: ['actual talk time', 'talk time', 'talktime', 'answer duration', 'talk duration', 'conversation time', 'conversation duration', 'billsec', 'answered duration', 'call answer duration', 'answer time'] },
  { key: 'holdTime', label: 'Hold time', required: false, keywords: ['hold time', 'hold duration', 'holdtime', 'hold'] },
  { key: 'wrapUpTime', label: 'Wrap-up time', required: false, keywords: ['wrap up time', 'wrapup time', 'wrap up duration', 'wrap time', 'acw', 'after call work', 'wrapup', 'wrap up'] },
  { key: 'disposition', label: 'Disposition', required: false, keywords: ['disposition', 'call disposition', 'dispo', 'call outcome', 'outcome', 'disposition name'] },
];

export const FIELD_KEYS = REPORT_FIELDS.map((f) => f.key);
export const REQUIRED_FIELDS = REPORT_FIELDS.filter((f) => f.required).map((f) => f.key);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function score(header, keywords) {
  const h = norm(header);
  let best = 0;
  keywords.forEach((k, i) => {
    const kw = norm(k);
    const rank = keywords.length - i; // earlier keywords are more specific
    if (h === kw) best = Math.max(best, 1000 + rank);
    else if (kw.length >= 4 && (` ${h} `).includes(` ${kw} `)) best = Math.max(best, 500 + kw.length * 5 + rank);
    else if (kw.length >= 5 && h.replace(/ /g, '').includes(kw.replace(/ /g, ''))) best = Math.max(best, 200 + kw.length + rank);
  });
  return best;
}

/** Suggest a header for each report field. Each header is used at most once (highest score wins). */
export function suggestMapping(headers, presets = []) {
  const hs = new Set(headers);
  for (const preset of presets) {
    const used = Object.values(preset.mapping || {}).filter(Boolean);
    if (used.length && used.every((h) => hs.has(h))) {
      return { mapping: { ...preset.mapping }, source: `Saved mapping "${preset.name}"`, presetId: String(preset._id) };
    }
  }
  const candidates = [];
  for (const f of REPORT_FIELDS) for (const h of headers) {
    const s = score(h, f.keywords);
    if (s > 0) candidates.push({ field: f.key, header: h, s });
  }
  candidates.sort((a, b) => b.s - a.s);
  const mapping = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  const usedHeaders = new Set();
  for (const c of candidates) {
    if (mapping[c.field] || usedHeaders.has(c.header)) continue;
    mapping[c.field] = c.header;
    usedHeaders.add(c.header);
  }
  return { mapping, source: 'Auto-detected from column names' };
}

const STATUS_MISSED = ['missed', 'no answer', 'noanswer', 'not answered', 'unanswered', 'busy', 'failed', 'abandon', 'rejected', 'cancel', 'unreachable', 'not connected', 'notconnected', 'no response', 'switched off', 'invalid'];
const STATUS_ANSWERED = ['answered', 'answer', 'connected', 'completed', 'success'];

/** Suggest status/disposition classification from the distinct values actually found in the file. */
export function suggestClassification(statusValues, dispositionValues) {
  const status = { answered: [], missed: [] };
  for (const v of statusValues) {
    if (STATUS_MISSED.some((k) => v.includes(k))) status.missed.push(v);
    else if (STATUS_ANSWERED.some((k) => v.includes(k))) status.answered.push(v);
  }
  const disposition = { interested: [], notInterested: [], callBack: [], answeredDisp: [] };
  for (const v of dispositionValues) {
    const compact = v.replace(/[^a-z]/g, '');
    if (/\bnot\s*interested\b/.test(v) || compact === 'ni') disposition.notInterested.push(v);
    else if (/\binterested\b/.test(v)) disposition.interested.push(v);
    if (/call\s*-?\s*back|callback|call\s+later|\bcb\b/.test(v)) disposition.callBack.push(v);
    if (compact === 'answered') disposition.answeredDisp.push(v);
  }
  return { status, disposition };
}

export const DEFAULT_OPTIONS = { dateOrder: 'DMY', durationFormat: 'auto', agentAliases: {} };
