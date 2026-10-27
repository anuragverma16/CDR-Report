import { config } from '../config.js';
import * as metaCloud from './metaCloud.js';
import * as nexsahay from './nexsahay.js';

function getProviderModule() {
  if (config.whatsapp.provider === 'meta_cloud') {
    return metaCloud;
  }
  return nexsahay;
}

export const PROVIDER = config.whatsapp.provider || 'nexsahay';
export const ProviderError = nexsahay.ProviderError;

export async function capabilities() {
  return getProviderModule().capabilities();
}

export async function sendMessage(destination, message) {
  return getProviderModule().sendMessage(destination, message);
}

export async function sendMedia(destination, opts) {
  const mod = getProviderModule();
  if (typeof mod.sendMedia === 'function') {
    return mod.sendMedia(destination, opts);
  }
  throw new Error(`sendMedia is not directly supported on provider ${config.whatsapp.provider}`);
}

export async function getGroupInfo(groupId) {
  return getProviderModule().getGroupInfo(groupId);
}

export async function listGroups() {
  const mod = getProviderModule();
  if (typeof mod.listGroups === 'function') {
    return mod.listGroups();
  }
  return [];
}

export async function uploadMedia(buffer, mimeType, filename) {
  const mod = getProviderModule();
  if (typeof mod.uploadMedia === 'function') {
    return mod.uploadMedia(buffer, mimeType, filename);
  }
  return null;
}

// Session management only exists on the Nexsahay gateway.
function requireNexsahay(op) {
  if (config.whatsapp.provider === 'meta_cloud') throw Object.assign(new Error(`${op} is only available with WHATSAPP_PROVIDER=nexsahay.`), { status: 400 });
}
export async function listSessions() { requireNexsahay('Listing sessions'); return nexsahay.listSessions(); }
export async function getSession(id) { requireNexsahay('Session details'); return nexsahay.getSession(id); }
export async function setSelectedSession(id, userId) { requireNexsahay('Selecting a session'); return nexsahay.setSelectedSession(id, userId); }
export async function listMessages(opts) { requireNexsahay('Listing messages'); return nexsahay.listMessages(opts); }

export function verifyWebhookSignature(rawBody, signatureHeader) {
  return metaCloud.verifyWebhookSignature(rawBody, signatureHeader);
}
