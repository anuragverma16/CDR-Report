import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const AREAS = ['uploads', 'reports'];
const SAFE_NAME = /^[a-f0-9]{32}\.(csv|xlsx|xls|png)$/;

export async function ensureStorage() {
  for (const a of AREAS) await fs.mkdir(path.join(config.storageDir, a), { recursive: true, mode: 0o750 });
}

export function randomName(ext) {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

/** Resolve a stored file path. Only server-generated names are accepted, so no path traversal is possible. */
export function storagePath(area, name) {
  if (!AREAS.includes(area) || !SAFE_NAME.test(name || '')) throw Object.assign(new Error('Invalid stored file reference'), { status: 400 });
  const root = path.join(config.storageDir, area);
  const full = path.resolve(root, name);
  if (path.dirname(full) !== root) throw Object.assign(new Error('Invalid stored file reference'), { status: 400 });
  return full;
}

export async function writeStored(area, ext, buffer) {
  const name = randomName(ext);
  await fs.writeFile(storagePath(area, name), buffer, { mode: 0o640 });
  return name;
}

export async function sha256File(p) {
  const buf = await fs.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}
