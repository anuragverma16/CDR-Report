import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { GeneratedReport, Destination, DeliveryLog, audit } from '../models/index.js';
import * as wa from '../whatsapp/index.js';
import { storagePath } from './storage.js';
import { config, whatsappConfigured } from '../config.js';
import { formatDuration } from './normalize.js';

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const ACTIVE = ['queued', 'sending', 'accepted', 'delivered'];

export function buildMessageText(report, attachments, destination) {
  const s = report.summary;
  const att = attachments === 'both' ? 'Agent-wise report and Excel workbook are attached.' : attachments === 'png' ? 'Agent-wise report image is attached.' : 'Excel workbook is attached.';
  return [
    ...(destination?.kind === 'group' ? ['Nexsahay Controller🚨', ''] : []),
    report.type === 'combined' ? 'TATA DIALER — COMBINED AGENT REPORT' : 'TATA DIALER — DAILY AGENT REPORT',
    '',
    `Report Date: ${report.reportDate}`,
    `Total Calls: ${s.totalCalls}`,
    `Answered: ${s.answered}`,
    `Missed: ${s.missed}`,
    `Answer Rate: ${s.answerRate === null ? 'N/A' : `${s.answerRate}%`}`,
    ...(s.talkSec !== null ? [`Talk Time: ${formatDuration(s.talkSec)}`] : []),
    '',
    att,
  ].join('\n');
}

/** Body variables for the approved template: {{1}} date {{2}} total {{3}} answered {{4}} missed {{5}} answer rate */
function templateParams(report) {
  const s = report.summary;
  return [report.reportDate, s.totalCalls, s.answered, s.missed, s.answerRate === null ? 'N/A' : `${s.answerRate}%`].map((v) => ({ type: 'text', text: String(v) }));
}

function partsFor(attachments) {
  if (attachments === 'excel') return ['document'];
  if (attachments === 'png') return ['image'];
  return ['image', 'document'];
}

function fileBase(report) {
  return `Tata_Dialer_Agent_Report_${String(report.data.reportDate).replace(/[^0-9A-Za-z_-]+/g, '_')}`;
}

async function deliverPart(part, report, destination) {
  const w = config.whatsapp;
  const text = buildMessageText(report.data, report.__attachments, destination);

  // Nexsahay WhatsApp Gateway (wa.sengarinfotech.com)
  if (w.provider === 'nexsahay') {
    if (part.kind === 'image') {
      const buf = await fs.readFile(storagePath('reports', report.imageFile));
      return wa.sendMedia(destination, {
        buffer: buf,
        mimeType: 'image/png',
        filename: `${fileBase(report)}.png`,
        caption: text,
        type: 'image',
      });
    }
    const buf = await fs.readFile(storagePath('reports', report.excelFile));
    const filename = `${fileBase(report)}.xlsx`;
    const caption = report.__attachments === 'both'
      ? `${destination.kind === 'group' ? 'Nexsahay Controller🚨 · ' : ''}Excel workbook — ${report.data.reportDate}`
      : text;
    return wa.sendMedia(destination, {
      buffer: buf,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename,
      caption,
      type: 'document',
    });
  }

  // Meta Cloud API Fallback
  const mode = config.whatsapp.messageMode;
  const payload = await buildPayload(part.kind, report, destination, mode);
  return wa.sendMessage(destination, payload);
}

async function buildPayload(kind, report, destination, mode) {
  const w = config.whatsapp;
  const text = buildMessageText(report.data, report.__attachments, destination);
  if (kind === 'image') {
    const buf = await fs.readFile(storagePath('reports', report.imageFile));
    if (buf.length > 5 * 1024 * 1024) throw new wa.ProviderError('Report image is larger than WhatsApp\'s 5 MB image limit. Send the Excel workbook instead.', { retryable: false });
    const id = await wa.uploadMedia(buf, 'image/png', `${fileBase(report)}.png`);
    if (mode === 'template') {
      if (!w.templateImage) throw new wa.ProviderError('WHATSAPP_TEMPLATE_IMAGE is not set. Create an approved template with an IMAGE header and 5 body variables.', { retryable: false });
      return { type: 'template', template: { name: w.templateImage, language: { code: w.templateLanguage }, components: [{ type: 'header', parameters: [{ type: 'image', image: { id } }] }, { type: 'body', parameters: templateParams(report.data) }] } };
    }
    return { type: 'image', image: { id, caption: text.slice(0, 1024) } };
  }
  const buf = await fs.readFile(storagePath('reports', report.excelFile));
  const filename = `${fileBase(report)}.xlsx`;
  const id = await wa.uploadMedia(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename);
  if (mode === 'template') {
    if (!w.templateDocument) throw new wa.ProviderError('WHATSAPP_TEMPLATE_DOCUMENT is not set. Create an approved template with a DOCUMENT header and 5 body variables.', { retryable: false });
    return { type: 'template', template: { name: w.templateDocument, language: { code: w.templateLanguage }, components: [{ type: 'header', parameters: [{ type: 'document', document: { id, filename } }] }, { type: 'body', parameters: templateParams(report.data) }] } };
  }
  // With an image already carrying the summary caption, the document gets a short caption
  const caption = report.__attachments === 'both'
    ? `${destination.kind === 'group' ? 'Nexsahay Controller🚨 · ' : ''}Excel workbook — ${report.data.reportDate}`
    : text;
  return { type: 'document', document: { id, filename, caption: caption.slice(0, 1024) } };
}

function rollupStatus(parts) {
  const st = parts.map((p) => p.status);
  if (st.every((s) => s === 'delivered' || s === 'read')) return 'delivered';
  if (st.some((s) => s === 'failed')) return st.some((s) => s !== 'failed' && s !== 'pending') ? 'partial' : 'failed';
  if (st.every((s) => ['accepted', 'sent', 'delivered', 'read'].includes(s))) return 'accepted';
  return 'sending';
}

async function refreshReportStatus(reportId) {
  const logs = await DeliveryLog.find({ reportId, trigger: { $ne: 'test' } }).select('status').lean();
  if (!logs.length) return;
  const st = logs.map((l) => l.status);
  let status = 'sending';
  if (st.every((s) => s === 'accepted' || s === 'delivered')) status = 'sent';
  else if (st.every((s) => s === 'failed')) status = 'failed';
  else if (st.some((s) => s === 'failed' || s === 'partial')) status = 'partial';
  await GeneratedReport.updateOne({ _id: reportId }, { deliveryStatus: status });
}

/**
 * Send (or resume) one delivery. Only parts that have not been accepted yet are sent,
 * so retries never duplicate a message that already went out.
 */
export async function performDelivery(logId) {
  const log = await DeliveryLog.findById(logId);
  const report = await GeneratedReport.findById(log.reportId);
  const destination = await Destination.findById(log.destinationId);
  log.attempts += 1;
  log.status = 'sending';
  log.history.push({ at: new Date(), event: 'attempt', detail: `Attempt ${log.attempts}` });
  await log.save();

  if (!destination?.verified) {
    log.status = 'failed';
    log.error = 'Destination is missing or not verified.';
    log.nextRetryAt = null;
    await log.save();
    return log;
  }
  const mode = config.whatsapp.messageMode;
  if (config.whatsapp.provider !== 'nexsahay' && mode === 'session' && destination.kind === 'individual' && (!destination.lastInboundAt || Date.now() - destination.lastInboundAt.getTime() > 24 * 3600 * 1000)) {
    log.parts.forEach((p) => { if (p.status === 'pending' || p.status === 'failed') Object.assign(p, { status: 'failed', error: 'Outside the 24-hour customer-service window. Use template mode or ask the recipient to message the business number first.', retryable: false, updatedAt: new Date() }); });
  } else {
    report.__attachments = log.attachments;
    for (const part of log.parts) {
      if (!['pending', 'failed'].includes(part.status)) continue;
      if (part.status === 'failed' && part.retryable === false && log.trigger === 'retry') continue;
      try {
        const res = await deliverPart(part, report, destination);
        Object.assign(part, { status: 'accepted', providerMessageId: res.id, error: null, errorCode: null, retryable: null, updatedAt: new Date() });
        log.history.push({ at: new Date(), event: 'accepted', detail: `${part.kind} accepted by WhatsApp (${res.id})` });
        await log.save(); // persist immediately so a crash or webhook race never re-sends this part
      } catch (e) {
        Object.assign(part, { status: 'failed', error: e.message, errorCode: e.code || null, retryable: e.retryable ?? false, updatedAt: new Date() });
        log.history.push({ at: new Date(), event: 'error', detail: `${part.kind}: ${e.message}` });
      }
    }
  }
  // re-read parts in case webhooks advanced them (sent/delivered) while we were sending
  const fresh = await DeliveryLog.findById(log._id).select('parts').lean();
  for (const p of log.parts) {
    const f = fresh.parts.find((x) => x.providerMessageId && x.providerMessageId === p.providerMessageId);
    if (f && STATUS_ORDER.indexOf(f.status) > STATUS_ORDER.indexOf(p.status)) p.status = f.status;
  }
  log.status = rollupStatus(log.parts);
  const failed = log.parts.filter((p) => p.status === 'failed');
  log.error = failed.map((p) => `${p.kind}: ${p.error}`).join(' | ') || null;
  const canRetry = failed.length && failed.every((p) => p.retryable) && log.attempts < config.retry.maxAttempts;
  log.nextRetryAt = canRetry ? new Date(Date.now() + config.retry.delayMinutes * 60000 * log.attempts) : null;
  await log.save();
  await refreshReportStatus(log.reportId);
  return log;
}

export async function sendReport(reportId, { destinationIds, attachments = 'both', trigger = 'manual', userId, force = false }) {
  if (!whatsappConfigured()) throw httpError(503, config.whatsapp.provider === 'nexsahay'
    ? 'WhatsApp is not configured on the server. Set NEXSAHAY_API_BASE in the server .env file.'
    : 'WhatsApp is not configured on the server. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in the server .env file.');
  const report = await GeneratedReport.findById(reportId);
  if (!report) throw httpError(404, 'Report not found');
  if (!report.data?.quality?.reconciliation?.slice(0, 4).every((c) => c.ok)) throw httpError(422, 'Report totals did not reconcile. Fix the data before sending.');
  if (attachments !== 'excel' && report.imageStatus !== 'ready') throw httpError(422, `The report image is not available (${report.imageError || 'not rendered'}). Send Excel only, or re-render the image.`);
  const dests = await Destination.find({ _id: { $in: destinationIds || [] } });
  if (!dests.length) throw httpError(400, 'Choose at least one destination.');
  const unverified = dests.filter((d) => !d.verified);
  if (unverified.length) throw httpError(422, `Not verified: ${unverified.map((d) => d.label).join(', ')}. Reports are only sent to verified destinations.`);
  if (dests.some((d) => d.kind === 'group') && !config.whatsapp.groupsEnabled) throw httpError(422, 'Group delivery is disabled. It needs Meta\'s Groups API (Official Business Account) — set WHATSAPP_GROUPS_ENABLED=true once approved.');

  const results = [];
  for (const d of dests) {
    const idempotencyKey = `${reportId}:${d._id}:${attachments}`;
    const existing = await DeliveryLog.findOne({ idempotencyKey, $or: [{ status: { $in: ACTIVE } }, { status: 'partial' }, { status: 'failed', nextRetryAt: { $ne: null } }] }).sort({ createdAt: -1 });
    if (existing && (!force || ['partial', 'failed', 'queued', 'sending'].includes(existing.status))) {
      const reason = existing.status === 'partial' || existing.status === 'failed'
        ? `A previous delivery is ${existing.status} and pending retry. Use Retry in Delivery Logs so already-delivered parts are not sent twice.`
        : `Already ${existing.status} at ${existing.updatedAt.toISOString()}. Confirm "send again" to deliver a second copy.`;
      results.push({ destination: d.label, skipped: true, status: existing.status, reason, logId: existing._id });
      continue;
    }
    const log = await DeliveryLog.create({
      reportId: report._id,
      destinationId: d._id,
      destinationLabel: d.label,
      destinationAddress: d.address,
      provider: wa.PROVIDER,
      attachments,
      trigger,
      status: 'queued',
      parts: partsFor(attachments).map((kind) => ({ kind, status: 'pending' })),
      messageText: buildMessageText(report.data, attachments, d),
      idempotencyKey,
      requestedBy: userId,
      history: [{ at: new Date(), event: 'queued', detail: force ? 'Repeat send confirmed by user' : `Requested (${trigger})` }],
    });
    const done = await performDelivery(log._id);
    results.push({ destination: d.label, logId: done._id, status: done.status, error: done.error, parts: done.parts });
  }
  await audit(userId, 'report.send', String(reportId), { attachments, trigger, results: results.map((r) => ({ d: r.destination, s: r.status || 'skipped' })) });
  return results;
}

/** Manual retry of a failed / partial delivery. Only the failed parts are re-sent. */
export async function retryDelivery(logId, userId) {
  const log = await DeliveryLog.findOneAndUpdate({ _id: logId, status: { $in: ['failed', 'partial'] } }, { status: 'sending', nextRetryAt: null }, { new: true });
  if (!log) throw httpError(409, 'Only failed or partially failed deliveries can be retried.');
  log.trigger = log.trigger === 'test' ? 'test' : 'retry';
  for (const p of log.parts) if (p.status === 'failed') p.retryable = true; // a human decided to retry
  log.markModified('parts');
  await log.save();
  await audit(userId, 'delivery.retry', String(logId));
  return performDelivery(log._id);
}

/** Called every minute by the scheduler. Claims due retries atomically so they run once. */
export async function processDueRetries() {
  for (let i = 0; i < 20; i++) {
    const log = await DeliveryLog.findOneAndUpdate(
      { status: { $in: ['failed', 'partial'] }, nextRetryAt: { $ne: null, $lte: new Date() }, attempts: { $lt: config.retry.maxAttempts } },
      { status: 'sending', nextRetryAt: null },
      { new: true, sort: { nextRetryAt: 1 } },
    );
    if (!log) return;
    await performDelivery(log._id).catch((e) => console.error('retry failed', e));
  }
}

// Webhook events are applied one at a time (in-process queue) and each part update is atomic,
// so concurrent status callbacks for the same delivery cannot overwrite each other.
let webhookQueue = Promise.resolve();
export function handleWebhook(body) {
  webhookQueue = webhookQueue.then(() => applyWebhook(body)).catch((e) => console.error('[webhook]', e));
  return webhookQueue;
}

const STATUS_ORDER = ['pending', 'accepted', 'sent', 'delivered', 'read'];

async function applyWebhook(body) {
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    const v = change.value || {};
    for (const s of v.statuses || []) {
      const current = await DeliveryLog.findOne({ 'parts.providerMessageId': s.id }).select('parts').lean();
      const idx = current ? current.parts.findIndex((p) => p.providerMessageId === s.id) : -1;
      if (idx < 0) continue;
      const part = current.parts[idx];
      const P = `parts.${idx}`;
      let set;
      if (s.status === 'failed') {
        const e = s.errors?.[0];
        set = { [`${P}.status`]: 'failed', [`${P}.error`]: e ? `${e.title || e.message} (${e.code})${e.error_data?.details ? ` — ${e.error_data.details}` : ''}` : 'Failed', [`${P}.errorCode`]: e?.code ? String(e.code) : null, [`${P}.retryable`]: [130429, 131000, 131016, 133004].includes(e?.code), [`${P}.updatedAt`]: new Date() };
      } else if (STATUS_ORDER.indexOf(s.status) > STATUS_ORDER.indexOf(part.status) && part.status !== 'failed') {
        set = { [`${P}.status`]: s.status, [`${P}.updatedAt`]: new Date() };
      }
      const push = { history: { at: new Date(), event: `webhook:${s.status}`, detail: `${part.kind} ${s.status}` } };
      // the filter pins the part index to this message id, so the update is atomic and race-free
      await DeliveryLog.updateOne({ _id: current._id, [`${P}.providerMessageId`]: s.id }, { ...(set && { $set: set }), $push: push });
      const log = await DeliveryLog.findById(current._id).lean();
      const status = rollupStatus(log.parts);
      const failed = log.parts.filter((p) => p.status === 'failed');
      const update = { status, error: failed.map((p) => `${p.kind}: ${p.error}`).join(' | ') || null };
      if ((status === 'failed' || status === 'partial') && failed.every((p) => p.retryable) && log.attempts < config.retry.maxAttempts) update.nextRetryAt = new Date(Date.now() + config.retry.delayMinutes * 60000);
      await DeliveryLog.updateOne({ _id: log._id }, update);
      await refreshReportStatus(log.reportId);
    }
    for (const m of v.messages || []) {
      const from = String(m.from || '').replace(/\D/g, '');
      if (!from) continue;
      await Destination.updateMany({ kind: 'individual', address: from }, { lastInboundAt: new Date() });
      const code = m.text?.body?.match(/VERIFY\s+(\d{6})/i)?.[1];
      if (code) {
        const hash = hashCode(code);
        const d = await Destination.findOne({ kind: 'individual', address: from, verificationCode: hash, verificationExpiresAt: { $gt: new Date() } });
        if (d) {
          Object.assign(d, { verified: true, verifiedAt: new Date(), verificationCode: null, verificationExpiresAt: null });
          await d.save();
          await audit(null, 'destination.verified', String(d._id), { via: 'whatsapp inbound message' });
        }
      }
    }
  }
}

export function hashCode(code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(String(code)).digest('hex');
}

export function newVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}
