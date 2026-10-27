/**
 * Official Meta WhatsApp Business Platform (Cloud API) client.
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/
 *
 * Important provider facts (checked Oct 2026):
 *  - Business-initiated messages need an approved message template, unless the recipient messaged
 *    the business in the last 24 hours (customer-service window).
 *  - The Cloud API cannot post into ordinary WhatsApp groups created by people in the WhatsApp app.
 *    The Groups API only works with groups the business creates through the API, requires an
 *    Official Business Account, and allows up to 8 participants per group.
 *  - A successful API response means Meta *accepted* the message. "sent / delivered / read / failed"
 *    arrive later through the webhook.
 */
import crypto from 'node:crypto';
import { config, whatsappConfigured } from '../config.js';

export const PROVIDER = 'meta_cloud';

const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 133004]);

export class ProviderError extends Error {
  constructor(message, { code, httpStatus, retryable, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = Boolean(retryable);
    this.details = details;
  }
}

function base() {
  return `${config.whatsapp.graphBaseUrl}/${config.whatsapp.apiVersion}`;
}

async function call(path, init = {}) {
  if (!whatsappConfigured()) throw new ProviderError('WhatsApp provider is not configured on the server (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).', { retryable: false });
  let res;
  try {
    res = await fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new ProviderError(`Network error reaching WhatsApp API: ${e.message}`, { retryable: true });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = body.error || {};
    const detail = err.error_data?.details ? ` — ${err.error_data.details}` : '';
    throw new ProviderError(`${err.message || `HTTP ${res.status}`}${detail}`, {
      code: err.code ? String(err.code) : String(res.status),
      httpStatus: res.status,
      retryable: res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(Number(err.code)),
      details: err,
    });
  }
  return body;
}

export async function uploadMedia(buffer, mimeType, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const body = await call(`/${config.whatsapp.phoneNumberId}/media`, { method: 'POST', body: form });
  return body.id;
}

export async function sendMessage(destination, message) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: destination.kind === 'group' ? 'group' : 'individual',
    to: destination.address,
    ...message,
  };
  const body = await call(`/${config.whatsapp.phoneNumberId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const id = body.messages?.[0]?.id;
  if (!id) throw new ProviderError('WhatsApp API returned no message id', { retryable: false, details: body });
  return { id, status: body.messages?.[0]?.message_status || 'accepted' };
}

/** Confirms a Groups-API group exists and is reachable by this business number. */
export async function getGroupInfo(groupId) {
  return call(`/${encodeURIComponent(groupId)}?fields=subject,suspended`);
}

export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) return false;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const got = signatureHeader.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function capabilities() {
  const w = config.whatsapp;
  return {
    provider: 'Meta WhatsApp Business Platform (Cloud API)',
    configured: whatsappConfigured(),
    webhookConfigured: Boolean(w.appSecret && w.webhookVerifyToken),
    apiVersion: w.apiVersion,
    businessNumber: w.businessNumberDisplay || null,
    messageMode: w.messageMode,
    templates: { image: w.templateImage || null, document: w.templateDocument || null, language: w.templateLanguage },
    groupsEnabled: w.groupsEnabled,
    limits: {
      imageMaxMb: 5,
      documentMaxMb: 100,
      templateWindow: 'Template messages can be sent at any time to opted-in recipients. Free-form (session) messages only work within 24 hours of the recipient\'s last message.',
      groups: 'The Cloud API cannot send to existing WhatsApp groups created in the WhatsApp app. Meta\'s Groups API only supports groups created by your business through the API (Official Business Account required, max 8 participants, members join via invite link). Recommended alternative: add each manager as an individual verified recipient.',
    },
  };
}
