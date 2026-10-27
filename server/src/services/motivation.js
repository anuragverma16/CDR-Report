import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Destination, ScheduledMessage, Setting, audit } from '../models/index.js';
import * as wa from '../whatsapp/index.js';
import { config } from '../config.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** A verified WhatsApp group: the only kind of destination team messages go to. */
async function verifiedGroup(destinationId) {
  const d = await Destination.findById(destinationId);
  if (!d || d.kind !== 'group' || !d.verified) throw httpError(422, 'Choose a verified WhatsApp group.');
  return d;
}

/** The date and time the user picked, read as Asia/Kolkata wall-clock time. */
export function sendInstant(date, time) {
  const at = dayjs.tz(`${date}T${time}:00`, config.timezone);
  // Reject impossible dates such as 2026-02-31: the converted value must show the same date and time back
  if (!at.isValid() || at.tz(config.timezone).format('YYYY-MM-DD HH:mm') !== `${date} ${time}`) throw httpError(422, 'Choose a valid date and time.');
  return at.toDate();
}

const DEFAULT_SLOTS = { morning: '09:30', evening: '18:00' };
const SLOT_KEY = 'motivation.slots';

/** The morning and evening send times, set by an admin (Asia/Kolkata). */
export async function getSlotTimes() {
  const s = await Setting.findOne({ key: SLOT_KEY }).lean();
  return { ...DEFAULT_SLOTS, ...(s?.value || {}) };
}

export async function saveSlotTimes({ morning, evening }, userId) {
  const value = { morning, evening };
  await Setting.findOneAndUpdate({ key: SLOT_KEY }, { value, updatedBy: userId }, { upsert: true });
  await audit(userId, 'motivation.slots', SLOT_KEY, value);
  return value;
}

/** Save a custom message to be sent on a chosen date, at the morning or evening slot. */
export async function schedule({ text, date, slot, destinationId, userId }) {
  const time = (await getSlotTimes())[slot];
  if (!time) throw httpError(422, 'Choose Morning or Evening.');
  const group = await verifiedGroup(destinationId);
  const sendAt = sendInstant(date, time);
  if (sendAt.getTime() < Date.now() + 60 * 1000) throw httpError(422, 'Choose a time at least one minute from now.');
  const msg = await ScheduledMessage.create({ text, destinationId: group._id, destinationLabel: group.label, sendAt, requestedBy: userId });
  await audit(userId, 'motivation.schedule', String(msg._id), { sendAt, group: group.label });
  return msg;
}

/** Send a custom message to the group now. */
export async function sendNow({ text, destinationId, userId }) {
  const group = await verifiedGroup(destinationId);
  const msg = await ScheduledMessage.create({ text, destinationId: group._id, destinationLabel: group.label, sendAt: new Date(), requestedBy: userId });
  await audit(userId, 'motivation.send', String(msg._id), { group: group.label });
  return deliverClaimed(msg._id);
}

/** Cancel a message that has not been sent yet. */
export async function cancel(id, userId) {
  const msg = await ScheduledMessage.findOneAndUpdate({ _id: id, status: { $in: ['pending', 'failed'] } }, { status: 'cancelled', nextRetryAt: null }, { new: true });
  if (!msg) throw httpError(409, 'Only messages that have not been sent can be cancelled.');
  await audit(userId, 'motivation.cancel', String(id));
  return msg;
}

/** Upcoming and past messages, newest scheduled time first. */
export async function list(limit = 100) {
  return ScheduledMessage.find().sort({ sendAt: -1 }).limit(limit).lean();
}

/**
 * Claim one message for sending (atomic, so two server instances cannot send it twice), then deliver it.
 * Returns null when another run already claimed it or it is not due.
 */
async function deliverClaimed(id) {
  const now = new Date();
  const msg = await ScheduledMessage.findOneAndUpdate(
    {
      _id: id,
      attempts: { $lt: config.retry.maxAttempts },
      $or: [{ status: 'pending', sendAt: { $lte: now } }, { status: 'failed', nextRetryAt: { $lte: now } }],
    },
    { status: 'sending', $inc: { attempts: 1 } },
    { new: true },
  );
  if (!msg) return null;
  try {
    const group = await Destination.findById(msg.destinationId);
    if (!group?.verified) throw Object.assign(new Error('The group is no longer verified.'), { retryable: false });
    const res = await wa.sendMessage(group, { text: msg.text });
    Object.assign(msg, { status: 'accepted', providerMessageId: res.id, providerStatus: res.status, error: null, nextRetryAt: null, sentAt: new Date() });
  } catch (e) {
    const retry = Boolean(e.retryable) && msg.attempts < config.retry.maxAttempts;
    Object.assign(msg, { status: 'failed', error: e.message, nextRetryAt: retry ? new Date(Date.now() + config.retry.delayMinutes * 60000 * msg.attempts) : null });
  }
  await msg.save();
  return msg;
}

/** Called every minute by the scheduler: sends messages that are due and retries failed ones. */
export async function motivationTick(now = new Date()) {
  const due = await ScheduledMessage.find({
    attempts: { $lt: config.retry.maxAttempts },
    $or: [{ status: 'pending', sendAt: { $lte: now } }, { status: 'failed', nextRetryAt: { $lte: now } }],
  }).select('_id').limit(20).lean();
  const out = [];
  for (const d of due) {
    const r = await deliverClaimed(d._id);
    if (r) out.push(r);
  }
  return out;
}
