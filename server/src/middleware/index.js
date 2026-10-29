import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { User } from '../models/index.js';
import { randomName } from '../services/storage.js';

export const COOKIE = 'tdr_session';

/**
 * Session cookie flags. Browsers only accept SameSite=None cookies that are also Secure, so the
 * cross-domain setup (client and API on different hosts) forces Secure whenever SameSite=None.
 */
export function cookieOptions(maxAge) {
  const sameSite = ['lax', 'strict', 'none'].includes(config.cookieSameSite) ? config.cookieSameSite : 'lax';
  return { httpOnly: true, sameSite, secure: config.cookieSecure || sameSite === 'none', ...(maxAge && { maxAge }) };
}

export function signSession(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) return res.status(401).json({ error: 'Account not active' });
    req.user = { id: String(user._id), email: user.email, name: user.name, role: user.role };
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

const RANK = { viewer: 1, manager: 2, admin: 3 };
/** viewer: read & download · manager: upload, process, generate, send · admin: settings, destinations, users */
export const requireRole = (min) => (req, res, next) => {
  if (!req.user || RANK[req.user.role] < RANK[min]) return res.status(403).json({ error: `This action needs the ${min} role` });
  next();
};

/** Reject cross-site state-changing requests (cookie auth + SameSite=Lax + Origin check). */
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/whatsapp/webhook')) return next();
  const origin = req.headers.origin;
  let sameHost = false;
  try { sameHost = !!origin && new URL(origin).host === req.headers.host; } catch { /* malformed origin */ }
  if (origin && !sameHost && !config.corsOrigin.split(',').map((s) => s.trim()).includes(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
}

const ALLOWED_EXT = { '.csv': 'csv', '.xlsx': 'xlsx', '.xls': 'xls' };

export const cdrUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(config.storageDir, 'uploads')),
    filename: (req, file, cb) => cb(null, randomName(ALLOWED_EXT[path.extname(file.originalname).toLowerCase()])),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: config.maxFilesPerUpload, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT[ext]) return cb(Object.assign(new Error(`${file.originalname}: only .xlsx, .xls and .csv files are accepted`), { status: 415 }));
    cb(null, true);
  },
});

export function fileTypeFromName(name) {
  return ALLOWED_EXT[path.extname(name).toLowerCase()];
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parseBody(schema, data) {
  return schema.parse(data);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid request', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${config.maxUploadMb} MB)` : err.code === 'LIMIT_FILE_COUNT' ? `Too many files (max ${config.maxFilesPerUpload})` : err.message;
    return res.status(413).json({ error: msg });
  }
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err.code === 11000) return res.status(409).json({ error: 'This employee or birthday entry already exists.' });
  if (err.name === 'CastError') return res.status(404).json({ error: 'Not found' });
  const status = err.status || 500;
  const intended = Boolean(err.status); // errors raised deliberately with a status carry a user-facing message
  if (!intended) console.error(err);
  res.status(status).json({ error: intended ? err.message : 'Internal server error' });
}
