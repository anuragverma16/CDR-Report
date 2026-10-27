import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Setting, Destination, MotivationLog, audit } from '../models/index.js';
import * as wa from '../whatsapp/index.js';
import { config } from '../config.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const SETTING_KEY = 'motivation.config';
const TYPES = ['morning', 'eod'];
const ANTHROPIC_MODEL = 'claude-haiku-5-5';
// A slot that was missed (server down) is still sent for this long after its time, then given up
const LATE_WINDOW_MINUTES = 180;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const DEFAULTS = {
  enabled: false,
  workingDays: [1, 2, 3, 4, 5], // dayjs weekday numbers: 0 = Sunday
  destinationId: null,
  morning: { enabled: true, time: '09:30', mode: 'predefined', text: '', variant: null },
  eod: { enabled: true, time: '18:00', mode: 'predefined', text: '', variant: null },
};

export const todayKey = () => dayjs().tz(config.timezone).format('YYYY-MM-DD');
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

// ---------- Message text (WhatsApp formatting: *bold*, one item per line) ----------
/** Signature required on every team message. */
export const SIGNATURE = '*Regards,*\n*Nexsahay Controller* 🚨';

/** Adds the signature unless the text already ends with it. */
export function withSignature(text) {
  const t = String(text).trimEnd();
  return t.endsWith(SIGNATURE) ? t : `${t}\n\n${SIGNATURE}`;
}

// Predefined morning variants. Index 0 is the approved wording; the others share its structure.
const MORNING = [
  `🌅 *GOOD MORNING, TEAM NEXSAHAY!*

🚀 A new day brings new opportunities and new possibilities!

Let's begin today with positive energy, confidence, and a clear goal. Every call matters, every follow-up creates an opportunity, and every small effort brings us closer to success.

💡 *Today's Reminder:*
✅ Stay focused on your goals.
✅ Make every conversation meaningful.
✅ Follow up consistently.
✅ Support your teammates and keep learning.

🔥 Success comes from consistency, patience, and never giving up. Let's make today productive and achieve something great together!

Wishing everyone a successful and energetic day ahead!`,
  `☀️ *GOOD MORNING, TEAM NEXSAHAY!*

Welcome to a fresh start. Today is a new chance to make progress, one conversation at a time.

💡 *Start Strong:*
✅ Plan your follow-ups before your first call.
✅ Listen closely and respond with care.
✅ Record every outcome accurately.
✅ Help a teammate when you can.

🔥 Discipline and persistence turn effort into results. Let's make today a good one!

Have a productive day, everyone!`,
  `🌟 *GOOD MORNING, TEAM NEXSAHAY!*

A new day, a new opportunity to do our best. Let's bring focus and energy to every call we make today.

💡 *Today's Focus:*
✅ Start with your priority follow-ups.
✅ Speak clearly and listen patiently.
✅ Keep your notes up to date.
✅ Celebrate small wins with the team.

🔥 Small steps every day build lasting success. Let's go!`,
  `🌤️ *GOOD MORNING, TEAM NEXSAHAY!*

Let's start the day with confidence and a positive mindset. Every call is a chance to help someone, and every follow-up brings us closer to our goals.

💡 *Remember:*
✅ Stay consistent with your calling.
✅ Follow up on time, every time.
✅ Learn from each conversation.
✅ Support one another as one team.

🚀 Have a focused and successful day ahead!`,
];

// Predefined evening variants. Index 0 is the approved wording.
const EVENING = [
  `🌆 *GOOD EVENING, TEAM NEXSAHAY!*

👏 Another day of effort, learning, and new experiences comes to an end.

Thank you, team, for your dedication and hard work. Remember, every conversation builds experience, every challenge teaches us something, and every consistent effort creates progress.

💡 *Before You Sign Off:*
✅ Review today's progress.
✅ Note your important follow-ups.
✅ Learn from the conversations that didn't go as planned.
✅ Prepare your priorities for tomorrow.

🔥 Don't measure success only by today's results. Measure it by your willingness to learn, improve, and show up again with determination.

Rest well, recharge your energy, and come back stronger tomorrow. Together, we keep moving forward!`,
  `🌇 *GOOD EVENING, TEAM NEXSAHAY!*

🙏 Thank you, team, for another day of hard work and commitment.

Every call and every follow-up adds to our experience. Take a moment to see what went well today and what you can do better tomorrow.

💡 *Before You Log Off:*
✅ Update your follow-up notes.
✅ Plan your first three calls for tomorrow.
✅ Reflect on one thing you learned today.
✅ Share a tip with a teammate.

🔥 Progress comes from showing up consistently. Rest well, and come back ready to go again!`,
  `🌙 *GOOD EVENING, TEAM NEXSAHAY!*

👏 Well done today, team! Every conversation, every call and every follow-up has helped us move forward.

Challenges are part of the journey. Learn from them, stay patient, and keep improving every day.

💡 *Evening Checklist:*
✅ Review your follow-ups.
✅ Note any lessons from difficult calls.
✅ Prepare your priorities for tomorrow.
✅ Take time to rest and recharge.

🔥 Keep your determination high and come back stronger tomorrow. Together, we keep moving forward!`,
  `🌆 *GOOD EVENING, TEAM NEXSAHAY!*

The day's work is done, and it has been a day of effort and learning. Thank you all for your hard work.

💡 *Before You Sign Off:*
✅ Review what you did today.
✅ Write down your next follow-ups.
✅ Learn from what didn't go as planned.
✅ Prepare tomorrow's priorities.

🔥 Measure success by how much you learn and grow, not only by one day's results. See you fresh tomorrow!`,
];

const variantsOf = (type) => (type === 'morning' ? MORNING : EVENING);
export const templateCount = (type) => variantsOf(type).length;

/**
 * Predefined text. `variant` picks a template (0-based); null rotates daily, moving by one each day
 * so consecutive days get different wording.
 */
function template(type, dateKey, variant = null) {
  const list = variantsOf(type);
  const dayNumber = Math.floor(dayjs(dateKey).valueOf() / 86400000);
  const i = Number.isInteger(variant) && variant >= 0 && variant < list.length ? variant : (dayNumber + (type === 'morning' ? 0 : 2)) % list.length;
  return withSignature(list[i]);
}

/** AI output must not contain figures, rankings, comparisons or claims about targets or achievements. */
const isSafe = (t) => Boolean(t) && t.length <= 1000 && !/\d{4,}|%|\btargets?\s+(were\s+|was\s+)?(achieved|hit|met|exceeded)|\brank|top performer|\bcompare|\bbetter than\b/i.test(t);

async function aiText(type) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const purpose = type === 'morning'
    ? 'a Good Morning message for the start of the working day. Encourage confidence, discipline, consistent calling, follow-ups and teamwork.'
    : 'a Good Evening message at the end of the working day. Appreciate effort, learning and teamwork; encourage reviewing follow-ups and preparing priorities for tomorrow.';
  const greeting = type === 'morning' ? 'Good Morning, Team Nexsahay!' : 'Good Evening, Team Nexsahay!';
  const prompt = `Write ${purpose} It is for a BDE sales team WhatsApp group. Use this layout: the first line is the greeting *${greeting}* in WhatsApp bold, then one flowing paragraph of about 70 to 100 words in a warm, professional, positive tone, with no bullet points or checklists. End the paragraph with one emoji. Do not invent achievements, targets or statistics. Do not criticise, shame, rank or compare anyone, and do not mention numbers, call counts, phone numbers or individual names. Do not write a signature, a sign-off or any other text. Output only the message text.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
    return isSafe(text) ? text : null;
  } catch {
    return null; // AI unavailable: fall back to the predefined text
  }
}

/** The text a message would have right now: custom text, AI wording, or a predefined template. Always signed. */
export async function composeText(type, { mode, text, variant } = {}, dateKey = todayKey()) {
  if (mode === 'custom' && text?.trim()) return withSignature(text.trim());
  if (mode === 'ai') {
    const generated = await aiText(type);
    if (generated) return withSignature(generated);
  }
  return template(type, dateKey, variant ?? null);
}

// ---------- Settings ----------
export async function getConfig() {
  const s = await Setting.findOne({ key: SETTING_KEY }).lean();
  const v = s?.value || {};
  return { ...DEFAULTS, ...v, morning: { ...DEFAULTS.morning, ...v.morning }, eod: { ...DEFAULTS.eod, ...v.eod } };
}

export async function saveConfig(next, userId) {
  if (next.destinationId) await targetGroup(next); // refuse to save a destination that cannot receive messages
  await Setting.findOneAndUpdate({ key: SETTING_KEY }, { value: next, updatedBy: userId }, { upsert: true });
  await audit(userId, 'motivation.config', SETTING_KEY, { enabled: next.enabled, workingDays: next.workingDays });
  return next;
}

async function targetGroup(cfg) {
  if (!cfg.destinationId) throw httpError(422, 'Choose the WhatsApp group that receives these messages.');
  const d = await Destination.findById(cfg.destinationId);
  if (!d || d.kind !== 'group' || !d.verified) throw httpError(422, 'The selected destination must be a verified WhatsApp group.');
  return d;
}

/** Next run of each message type from now, skipping days that are not working days. */
export function nextRuns(cfg, now = new Date()) {
  const out = {};
  for (const type of TYPES) {
    const c = cfg[type];
    if (!cfg.enabled || !c.enabled || !cfg.workingDays.length) { out[type] = null; continue; }
    const [h, m] = c.time.split(':').map(Number);
    let d = dayjs(now).tz(config.timezone).hour(h).minute(m).second(0).millisecond(0);
    if (d.isBefore(dayjs(now))) d = d.add(1, 'day').hour(h).minute(m);
    for (let i = 0; i < 8 && !cfg.workingDays.includes(d.day()); i++) d = d.add(1, 'day').hour(h).minute(m);
    out[type] = d.toDate();
  }
  return out;
}

// ---------- Sending ----------
/** Send one log row to the group and record the provider's answer on it. */
async function deliver(log, destination) {
  log.attempts += 1;
  log.status = 'sending';
  await log.save();
  try {
    const res = await wa.sendMessage(destination, { text: log.text });
    Object.assign(log, { status: 'accepted', providerMessageId: res.id, providerStatus: res.status, error: null, nextRetryAt: null, sentAt: new Date() });
  } catch (e) {
    const retry = Boolean(e.retryable) && log.attempts < config.retry.maxAttempts;
    Object.assign(log, { status: 'failed', error: e.message, nextRetryAt: retry ? new Date(Date.now() + config.retry.delayMinutes * 60000 * log.attempts) : null });
  }
  await log.save();
  return log;
}

/** Scheduled send. The unique index on (type, day, group) makes the slot run at most once. */
async function runScheduled(type, cfg, slot) {
  const destination = await targetGroup(cfg);
  const dateKey = slot.format('YYYY-MM-DD');
  let log;
  try {
    log = await MotivationLog.create({
      type, kind: 'scheduled', dateKey, destinationId: destination._id, destinationLabel: destination.label,
      text: await composeText(type, cfg[type], dateKey), status: 'sending', attempts: 0, scheduledFor: slot.toDate(),
    });
  } catch (e) {
    if (e.code === 11000) return null; // already sent, or being sent, for this slot
    throw e;
  }
  return deliver(log, destination);
}

/** Called every minute by the scheduler. */
export async function motivationTick(now = new Date()) {
  const cfg = await getConfig();
  if (!cfg.enabled) return [];
  const local = dayjs(now).tz(config.timezone);
  const sent = [];
  if (cfg.workingDays.includes(local.day())) {
    for (const type of TYPES) {
      const c = cfg[type];
      if (!c.enabled) continue;
      const [h, m] = c.time.split(':').map(Number);
      const slot = local.hour(h).minute(m).second(0).millisecond(0);
      const lateBy = local.diff(slot, 'minute');
      if (lateBy < 0 || lateBy > LATE_WINDOW_MINUTES) continue;
      const r = await runScheduled(type, cfg, slot);
      if (r) sent.push(r);
    }
  }
  return [...sent, ...(await processRetries(now))];
}

/** Retry failed sends whose retry time has come, within the configured attempt limit. */
export async function processRetries(now = new Date()) {
  const due = await MotivationLog.find({ status: 'failed', nextRetryAt: { $lte: now }, attempts: { $lt: config.retry.maxAttempts } }).limit(20);
  const out = [];
  for (const log of due) {
    const destination = await Destination.findById(log.destinationId);
    if (!destination?.verified) { log.nextRetryAt = null; await log.save(); continue; }
    out.push(await deliver(log, destination));
  }
  return out;
}

/** "Send Now" and "Send test": sent immediately to the group. Test messages are marked in the log. */
export async function sendNow({ type, text, userId }) {
  const cfg = await getConfig();
  const destination = await targetGroup(cfg);
  const base = type === 'test' ? 'morning' : type;
  const body = text?.trim() || await composeText(base, cfg[base], todayKey());
  const log = await MotivationLog.create({
    type, kind: type === 'test' ? 'test' : 'manual', dateKey: todayKey(), destinationId: destination._id, destinationLabel: destination.label,
    text: type === 'test' ? `[Test] ${body}` : body, status: 'sending', attempts: 0, requestedBy: userId,
  });
  await audit(userId, 'motivation.send', String(log._id), { type });
  return deliver(log, destination);
}

export async function history(limit = 50) {
  return MotivationLog.find().sort({ createdAt: -1 }).limit(limit).lean();
}
