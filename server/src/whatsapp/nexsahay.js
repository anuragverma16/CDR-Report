/**
 * Client for the Nexsahay WhatsApp Gateway.
 * API docs: https://wa.sengarinfotech.com/api-docs  (base URL https://whatsappbackend.sengarinfotech.com/api)
 *
 * Facts from the docs (checked Oct 2026):
 *  - GET /sessions, GET /sessions/:id, GET /contacts, GET /groups, GET /messages need no API key.
 *  - POST /messages/send and POST /messages/send-media need `x-api-key`, and the key belongs to ONE session
 *    (each session has its own `wa_...` key, returned by GET /sessions).
 *  - `to` accepts a bare number (country code, no +) or a full JID (group JIDs end in @g.us).
 *  - A session must be CONNECTED to send. QR_READY means it is waiting for a phone to scan its QR code.
 *  - The gateway has no delivery-status webhook, so "accepted" (data.sent = true) is the final status we get.
 */
import { config } from '../config.js';
import { Setting } from '../models/index.js';

export const PROVIDER = 'nexsahay';
export const SESSION_SETTING_KEY = 'whatsapp.nexsahay.sessionId';

export class ProviderError extends Error {
  constructor(message, { code, httpStatus, retryable, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = Boolean(retryable);
    this.details = details;
  }
}

function getBaseUrl() {
  return (config.whatsapp.nexsahay?.baseUrl || 'https://whatsappbackend.sengarinfotech.com/api').replace(/\/+$/, '');
}

/** The session's own key wins (keys are per session); NEXSAHAY_API_KEY is only a fallback. */
function authHeaders(session, extra = {}) {
  const key = session?.apiKey || config.whatsapp.nexsahay?.apiKey || '';
  return { ...(key ? { 'x-api-key': key } : {}), ...tenantHeader(session), ...extra };
}

/** Multi-tenant gateway: sessions that belong to a tenant are addressed with that tenant's id. */
function tenantHeader(session) {
  return session?.tenantId ? { 'x-tenant-id': session.tenantId } : {};
}

async function getJson(path, operation, timeout = 15000, headers = {}) {
  const url = `${getBaseUrl()}${path}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new ProviderError(`${operation}: cannot reach the Nexsahay gateway (${e.message})`, { retryable: true });
  }
  return decodeResponse(res, operation);
}

export async function listSessions() {
  const body = await getJson('/sessions', 'List sessions', 10000);
  const sessions = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.sessions) ? body.data.sessions : null;
  if (!sessions) throw new ProviderError('Nexsahay returned an unexpected sessions response. Check NEXSAHAY_API_BASE.', { retryable: false });
  return sessions;
}

/** Single session incl. the QR data URL while it is pairing (status QR_READY). */
export async function getSession(id) {
  const body = await getJson(`/sessions/${encodeURIComponent(id)}`, 'Get session');
  return body.data || null;
}

/** Session chosen in the WhatsApp panel, else NEXSAHAY_SESSION_ID, else none (first connected is used). */
export async function selectedSessionId() {
  const s = await Setting.findOne({ key: SESSION_SETTING_KEY }).lean().catch(() => null);
  return s?.value || config.whatsapp.nexsahay?.sessionId || '';
}

export async function setSelectedSession(sessionId, userId) {
  await Setting.findOneAndUpdate({ key: SESSION_SETTING_KEY }, { value: sessionId || null, updatedBy: userId }, { upsert: true });
}

/** Gateway names look like "[tenant-id] Name"; users only need the name. */
const shortSessionName = (name) => String(name || '').replace(/^\[[^\]]+\]\s*/, '');

const isConnected = (s) => String(s?.status).toUpperCase() === 'CONNECTED';

export async function getActiveSession() {
  const chosenId = await selectedSessionId();
  const sessions = await listSessions();
  if (chosenId) {
    const chosen = sessions.find((s) => s.id === chosenId);
    if (!chosen) throw new ProviderError(`The selected WhatsApp session (${chosenId}) no longer exists on the gateway. Pick another session on the WhatsApp page.`, { retryable: false });
    if (!isConnected(chosen)) {
      throw new ProviderError(`WhatsApp session "${shortSessionName(chosen.name)}" is ${chosen.status}, not CONNECTED. ${String(chosen.status).toUpperCase() === 'QR_READY' ? 'Open the WhatsApp page, click "Show QR" and scan it with WhatsApp on your phone (Linked devices).' : 'Its phone has unlinked. On the WhatsApp page, click "Add number", then scan the new QR code with WhatsApp on that phone (Linked devices).'}`, { retryable: false });
    }
    return chosen;
  }
  const connected = sessions.find(isConnected);
  if (connected) return connected;
  const summary = sessions.length ? sessions.map((s) => `"${s.name}" is ${s.status}`).join(', ') : 'no sessions exist';
  throw new ProviderError(`No CONNECTED WhatsApp session on the gateway (${summary}). Scan a session's QR code on the WhatsApp page to connect it.`, { retryable: false });
}

export function formatJid(address, kind = 'individual') {
  if (!address) return '';
  const cleaned = String(address).trim();
  if (cleaned.endsWith('@g.us') || cleaned.endsWith('@s.whatsapp.net')) return cleaned;
  if (kind === 'group' || cleaned.includes('-') || cleaned.length >= 18) {
    return `${cleaned.replace(/[^0-9_\-]/g, '')}@g.us`;
  }
  return cleaned.replace(/\D/g, '');
}

export async function listGroups() {
  const session = await getActiveSession();
  const body = await getJson(`/contacts?sessionId=${encodeURIComponent(session.id)}`, 'List groups', 15000, tenantHeader(session));
  const contacts = Array.isArray(body.data) ? body.data : [];
  return contacts
    .filter((c) => c.isGroup || String(c.jid || '').endsWith('@g.us'))
    .map((g) => ({ jid: g.jid, name: g.name || g.subject || g.jid, phoneNumber: g.phoneNumber || null, isGroup: true }));
}

export async function getGroupInfo(groupId) {
  const session = await getActiveSession();
  const jid = formatJid(groupId, 'group');
  const body = await getJson(`/groups?sessionId=${encodeURIComponent(session.id)}&jid=${encodeURIComponent(jid)}`, `Get group ${jid}`, 15000, tenantHeader(session));
  return { jid, subject: body.data?.subject || jid, participants: body.data?.participants || [] };
}

/** Recent messages for the active session (newest first as returned by the gateway). */
export async function listMessages({ remoteJid, pageSize = 20 } = {}) {
  const session = await getActiveSession();
  const q = new URLSearchParams({ sessionId: session.id, pageSize: String(pageSize), fromMe: 'true', ...(remoteJid && { remoteJid }) });
  const body = await getJson(`/messages?${q}`, 'List messages', 15000, tenantHeader(session));
  return Array.isArray(body.data) ? body.data : [];
}

export async function sendMessage(destination, message) {
  const session = await getActiveSession();
  const text = typeof message === 'string' ? message : message.text || message.message || '';
  const body = await postJson(session, '/messages/send', { sessionId: session.id, to: formatJid(destination.address, destination.kind), message: text }, 'Send WhatsApp message');
  return { id: requireMessageId(body, 'Send WhatsApp message'), status: 'accepted' };
}

export async function sendMedia(destination, { buffer, mimeType, filename, caption, type }) {
  const session = await getActiveSession();
  const fd = new FormData();
  fd.set('sessionId', session.id);
  fd.set('to', formatJid(destination.address, destination.kind));
  fd.set('type', type || (mimeType.startsWith('image/') ? 'image' : 'document'));
  if (caption) fd.set('caption', caption);
  if (filename) fd.set('fileName', filename);
  if (mimeType) fd.set('mimetype', mimeType);
  fd.set('file', new Blob([buffer], { type: mimeType }), filename || `file-${Date.now()}`);
  const body = await postForm(session, '/messages/send-media', fd, 'Send media via WhatsApp');
  return { id: requireMessageId(body, 'Send media via WhatsApp'), status: 'accepted' };
}

export async function capabilities() {
  let sessions = [];
  let active = null;
  let connectionError = null;
  try { sessions = await listSessions(); } catch (e) { connectionError = e.message; }
  if (!connectionError) { try { active = await getActiveSession(); } catch (e) { connectionError = e.message; } }
  const chosenId = await selectedSessionId();
  return {
    provider: 'Nexsahay WhatsApp Gateway',
    providerKey: 'nexsahay',
    baseUrl: getBaseUrl(),
    configured: Boolean(active),
    connectionError,
    serviceUrl: 'https://wa.sengarinfotech.com/sessions',
    docsUrl: 'https://wa.sengarinfotech.com/api-docs',
    // never send keys to the browser
    sessions: sessions.map((s) => ({ id: s.id, name: s.name, status: s.status, hasApiKey: Boolean(s.apiKey) })),
    selectedSessionId: chosenId || null,
    activeSession: active ? { id: active.id, name: active.name, status: active.status } : null,
    keySource: active?.apiKey ? 'session' : config.whatsapp.nexsahay?.apiKey ? 'env' : 'none',
    groupsEnabled: true,
    messageMode: 'session',
    templates: { image: null, document: null, language: 'en' },
    businessNumber: active?.name || null,
    webhookConfigured: false,
    limits: {
      imageMaxMb: 16,
      documentMaxMb: 100,
      templateWindow: 'No 24-hour template restriction: messages go out through your linked WhatsApp session.',
      groups: 'Can post to any WhatsApp group the linked number is a member of (group JIDs end in @g.us).',
    },
  };
}

function getMessageId(body) {
  return body?.data?.waMessageId || body?.data?.messageId || body?.data?.id || body?.waMessageId || body?.messageId || body?.id || null;
}

/** Only report success when the gateway confirms it (docs: data.sent = true plus a message id). */
function requireMessageId(body, operation) {
  if (body?.data?.sent === false) throw new ProviderError(`${operation}: gateway reported sent=false`, { retryable: true, details: body });
  const id = getMessageId(body);
  if (!id) throw new ProviderError(`${operation}: gateway returned no message id, so delivery cannot be confirmed.`, { retryable: false, details: body });
  return id;
}

async function decodeResponse(res, operation) {
  const raw = await res.text().catch(() => '');
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { response: raw.slice(0, 500) }; }
  const rejected = body.success === false || ['error', 'failed', 'failure'].includes(String(body.status || '').toLowerCase());
  if (!res.ok || rejected) {
    const message = body.message || body.error?.message || (typeof body.error === 'string' ? body.error : '') || operation;
    const hint = res.status === 401 || res.status === 403 ? ' — the API key does not match this session.' : '';
    throw new ProviderError(`${message} (HTTP ${res.status})${hint}`, { httpStatus: res.status, retryable: res.status === 429 || res.status >= 500, details: body });
  }
  if (!raw) throw new ProviderError(`${operation}: gateway returned an empty response.`, { httpStatus: res.status, retryable: false });
  return body;
}

async function postJson(session, path, payload, operation) {
  let res;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: authHeaders(session, { 'Content-Type': 'application/json', Accept: 'application/json' }), body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
  } catch (e) { throw new ProviderError(`${operation}: ${e.message}`, { retryable: true }); }
  return decodeResponse(res, operation);
}

async function postForm(session, path, form, operation) {
  let res;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: authHeaders(session, { Accept: 'application/json' }), body: form, signal: AbortSignal.timeout(90000) });
  } catch (e) { throw new ProviderError(`${operation}: ${e.message}`, { retryable: true }); }
  return decodeResponse(res, operation);
}
