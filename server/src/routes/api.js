import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import path from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import { z } from 'zod';
import { config, whatsappConfigured } from '../config.js';
import { User, UploadedCDR, GeneratedReport, Destination, DeliveryLog, ColumnMapping, CdrRecord, AutomationUpload, ROLES, audit } from '../models/index.js';
import { requireAuth, requireRole, signSession, COOKIE, cdrUpload, asyncH } from '../middleware/index.js';
import { handleUploads, previewFile, processFile, deleteFile, importForReport } from '../services/cdrService.js';
import { generateReport, retryImage, dashboardSummary } from '../services/reportService.js';
import { sendReport, retryDelivery, newVerificationCode, hashCode, buildMessageText } from '../services/deliveryService.js';
import { getSchedule, reloadSchedule, executeSchedule, nextRun, cronFor } from '../services/scheduler.js';
import { storagePath } from '../services/storage.js';
import * as mot from '../services/motivation.js';
import { mysqlStatus, fetchLiveReport } from '../services/mysqlSource.js';
import { REPORT_FIELDS } from '../services/mapping.js';
import { parseCdrFile, sniffType } from '../services/parser.js';
import * as wa from '../whatsapp/index.js';
import { writeStored } from '../services/storage.js';

const router = express.Router();
const automationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 }, fileFilter: (req, file, cb) => {
  if (!/\.(xlsx|xls|csv)$/i.test(file.originalname)) return cb(Object.assign(new Error('Upload a .xlsx, .xls or .csv file.'), { status: 415 }));
  cb(null, true);
} });
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const labelList = z.array(z.string().max(200)).max(500);
const mappingSchema = z.record(z.enum(REPORT_FIELDS.map((f) => f.key)), z.string().max(300).nullable());
const optionsSchema = z.object({
  dateOrder: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
  durationFormat: z.enum(['auto', 'seconds', 'minutes', 'hms']).default('auto'),
  agentAliases: z.record(z.string().max(200), z.string().max(200)).default({}),
}).partial();
const classificationSchema = z.object({
  status: z.object({ answered: labelList, missed: labelList }),
  disposition: z.object({ interested: labelList, notInterested: labelList, callBack: labelList, answeredDisp: labelList }).partial().default({}),
});

// ---------- Auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post('/auth/login', loginLimiter, asyncH(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
  user.lastLoginAt = new Date();
  await user.save();
  res.cookie(COOKIE, signSession(user), { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 12 * 3600 * 1000 });
  await audit(user._id, 'auth.login', user.email);
  res.json({ user: { id: user._id, email: user.email, name: user.name, role: user.role } });
}));

router.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

router.use(requireAuth);

// ---------- Report automation: allowlisted CDR query + isolated workbook uploads ----------
const automationFilterSchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), agent: z.string().max(120).optional(), status: z.string().max(80).optional(), page: z.coerce.number().int().min(1).default(1) });
const automationFields = ['reportDate', 'agentName', 'callId', 'phone', 'startAt', 'statusLabel', 'dispositionLabel', 'talkSec', 'holdSec', 'wrapSec'];
function automationQuery(q) {
  const f = { valid: true };
  if (q.from || q.to) f.reportDate = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  if (q.agent) f.agentName = q.agent;
  if (q.status) f.statusLabel = q.status;
  return f;
}
function safeCell(v) { return v instanceof Date ? v.toISOString() : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v; }
async function workbookSheet(buffer, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('Worksheet not found.'), { status: 404 });
  const headers = (ws.getRow(1).values || []).slice(1).map((x, i) => String(x ?? `Column ${i + 1}`).trim());
  if (!headers.length || !headers.some(Boolean)) throw Object.assign(new Error('Worksheet has no header row.'), { status: 422 });
  const rows = [];
  ws.eachRow((row, n) => { if (n > 1) rows.push(Object.fromEntries(headers.map((h, i) => [h, safeCell(row.getCell(i + 1).value)]))); });
  return { headers, rows, name: ws.name };
}
/** One "sheet" for CSV / legacy XLS, read with the same parser as Upload CDR (header detection, delimiter sniffing). */
async function flatFileSheet(filePath, fileType, name) {
  const parsed = await parseCdrFile(filePath, fileType);
  return { headers: parsed.headers, rows: parsed.rows.map((r) => Object.fromEntries(parsed.headers.map((h) => [h, safeCell(r.values[h])]))), name: parsed.sheetName || name, warning: parsed.warning };
}
async function automationSheet(u, sheetName) {
  const p = storagePath('uploads', u.storedName);
  if (u.fileType === 'csv' || u.fileType === 'xls') return flatFileSheet(p, u.fileType, u.sheets?.[0]?.name || 'Data');
  return workbookSheet(await fs.promises.readFile(p), sheetName);
}
router.get('/report-automation/status', asyncH(async (req, res) => res.json({ connected: mongoose.connection.readyState === 1, database: 'MongoDB', source: 'Normalized CDR records', fields: automationFields, maxRows: 5000 })));
router.get('/report-automation/agents', asyncH(async (req, res) => res.json({ agents: (await CdrRecord.distinct('agentName', { valid: true })).filter(Boolean).sort() })));
router.get('/report-automation/database', asyncH(async (req, res) => {
  const q = automationFilterSchema.parse(req.query); const filter = automationQuery(q); const limit = 100;
  const [total, rows] = await Promise.all([CdrRecord.countDocuments(filter).maxTimeMS(5000), CdrRecord.find(filter).select(automationFields.join(' ')).sort({ reportDate: -1, startAt: -1, _id: 1 }).skip((q.page - 1) * limit).limit(limit).maxTimeMS(5000).lean()]);
  res.json({ total, page: q.page, pageSize: limit, fields: automationFields, rows });
}));
router.get('/report-automation/database/excel', requireRole('manager'), asyncH(async (req, res) => {
  const q = automationFilterSchema.omit({ page: true }).parse(req.query); const rows = await CdrRecord.find(automationQuery(q)).select(automationFields.join(' ')).sort({ reportDate: -1, startAt: -1 }).limit(5000).maxTimeMS(8000).lean();
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('CDR Report'); ws.columns = automationFields.map((key) => ({ header: key, key, width: 20 })); rows.forEach((row) => ws.addRow(Object.fromEntries(automationFields.map((k) => [k, safeCell(row[k])]))));
  const buffer = await wb.xlsx.writeBuffer(); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', 'attachment; filename="Tata_Dialer_CDR_Report.xlsx"').set('Cache-Control', 'private, no-store').send(Buffer.from(buffer));
}));
router.post('/report-automation/upload', requireRole('manager'), automationUpload.single('file'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Select a .xlsx, .xls or .csv file.' });
  // Browsers report CSV under many MIME types; the content is checked by sniffing below instead.
  const sniffed = sniffType(req.file.buffer);
  if (sniffed === 'binary') return res.status(422).json({ error: 'The file is not a valid CSV, XLSX or XLS file.' });
  const originalName = path.basename(req.file.originalname);
  const storedName = await writeStored('uploads', sniffed, req.file.buffer);
  let sheets;
  let warning = null;
  try {
    if (sniffed === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      if (!wb.worksheets.length) throw Object.assign(new Error('Workbook contains no worksheets.'), { status: 422 });
      sheets = wb.worksheets.map((ws) => ({ name: ws.name, rowCount: Math.max(0, ws.rowCount - 1), headers: (ws.getRow(1).values || []).slice(1).map((x) => String(x ?? '')) }));
    } else {
      const declared = path.extname(originalName).slice(1).toLowerCase();
      const flat = await flatFileSheet(storagePath('uploads', storedName), declared, path.parse(originalName).name.slice(0, 80) || 'Data');
      sheets = [{ name: flat.name, rowCount: flat.rows.length, headers: flat.headers }];
      warning = flat.warning;
    }
  } catch (e) {
    await fs.promises.unlink(storagePath('uploads', storedName)).catch(() => {});
    return res.status(e.status || 422).json({ error: e.status ? e.message : `The file could not be read: ${e.message}` });
  }
  const upload = await AutomationUpload.create({ originalName, storedName, fileType: sniffed, size: req.file.size, uploadedBy: req.user.id, sheets, expiresAt: new Date(Date.now() + 30 * 86400000) });
  res.status(201).json({ upload: { id: upload.id, originalName: upload.originalName, fileType: sniffed, size: upload.size, sheets, expiresAt: upload.expiresAt }, warning });
}));
router.get('/report-automation/upload/:id/preview', asyncH(async (req, res) => {
  const u = await AutomationUpload.findOne({ _id: objectId.parse(req.params.id), uploadedBy: req.user.id }).lean(); if (!u) return res.status(404).json({ error: 'Uploaded workbook not found or expired.' });
  const sheet = await automationSheet(u, req.query.sheet ? String(req.query.sheet) : undefined);
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1)); const start = (page - 1) * 50;
  res.json({ filename: u.originalName, size: u.size, sheets: u.sheets, sheet: sheet.name, headers: sheet.headers, total: sheet.rows.length, page, pageSize: 50, rows: sheet.rows.slice(start, start + 50) });
}));
router.get('/report-automation/upload/:id/excel', requireRole('manager'), asyncH(async (req, res) => {
  const u = await AutomationUpload.findOne({ _id: objectId.parse(req.params.id), uploadedBy: req.user.id }).lean(); if (!u) return res.status(404).json({ error: 'Uploaded workbook not found or expired.' });
  const result = await automationSheet(u, req.query.sheet ? String(req.query.sheet) : undefined);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(String(result.name || 'Data').replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Data'); ws.columns = result.headers.map((header) => ({ header, width: 20 })); result.rows.forEach((row) => ws.addRow(result.headers.map((h) => row[h])));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', 'attachment; filename="Validated_Report.xlsx"').set('Cache-Control', 'private, no-store').send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

// Manual fallback when no live CDR feed is available: turn the uploaded file into the standard agent report.
router.post('/report-automation/upload/:id/generate', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ reportDate: isoDate.optional() }).parse(req.body);
  const u = await AutomationUpload.findOne({ _id: objectId.parse(req.params.id), uploadedBy: req.user.id }).lean();
  if (!u) return res.status(404).json({ error: 'Uploaded file not found or expired. Upload it again.' });
  const imported = await importForReport(storagePath('uploads', u.storedName), { originalName: u.originalName, fileType: u.fileType || 'xlsx' }, req.user);
  const dates = (imported.summary?.dates || []).map((d) => d.value).sort();
  const reportDate = b.reportDate || imported.suggestedReportDate || dates.at(-1);
  if (!reportDate) return res.status(422).json({ error: 'No valid call dates were found in this file, so no report can be built.' });
  if (dates.length && !dates.includes(reportDate)) return res.status(422).json({ error: `The file has no calls on ${reportDate}. Dates in this file: ${dates.join(', ')}.` });
  const doc = await generateReport({ type: 'single', fileIds: [imported.file._id], reportDate, restrictToDate: true, userId: req.user.id });
  res.status(201).json({ report: doc.toObject(), reportDate, dates, reused: imported.reused, stats: imported.file.stats, unclassifiedStatuses: imported.unclassifiedStatuses || [] });
}));

// ---------- Live report: fetch the day's calls from MySQL, build the report, then send ----------
router.get('/live/status', asyncH(async (req, res) => res.json(await mysqlStatus())));
// Day's Tata Dialer export: only used to fill hold, wrap-up and dispositions of the MySQL calls (matched by call ID)
router.post('/live/export', requireRole('manager'), cdrUpload.single('file'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Select the Tata Dialer export (.csv or .xlsx).' });
  try {
    const imported = await importForReport(req.file.path, { originalName: path.basename(req.file.originalname), fileType: req.file.filename.split('.').pop() }, req.user);
    if (!imported.file.mapping?.callId) return res.status(422).json({ error: 'This file has no Call ID column, so its calls cannot be matched to the database.' });
    res.status(201).json({ file: { name: imported.file.originalName, dateRange: imported.file.dateRange, stats: imported.file.stats }, reused: imported.reused });
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));
router.post('/live/fetch', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ reportDate: isoDate }).parse(req.body);
  res.status(201).json(await fetchLiveReport({ date: b.reportDate, user: req.user, trigger: 'manual' }));
}));

router.get('/auth/me', (req, res) => res.json({ user: req.user }));

router.get('/users', requireRole('admin'), asyncH(async (req, res) => {
  res.json({ users: await User.find().select('-passwordHash').sort({ createdAt: 1 }).lean() });
}));
router.post('/users', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(10).max(200), role: z.enum(ROLES) }).parse(req.body);
  const u = await User.create({ email: b.email, name: b.name, role: b.role, passwordHash: await bcrypt.hash(b.password, 12) });
  await audit(req.user.id, 'user.create', u.email, { role: b.role });
  res.status(201).json({ user: { id: u._id, email: u.email, name: u.name, role: u.role } });
}));

// ---------- CDR files ----------
router.post('/cdr/upload', requireRole('manager'), cdrUpload.array('files'), asyncH(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files received. Use the "files" form field.' });
  res.status(201).json({ results: await handleUploads(req.files, req.user) });
}));

router.post('/cdr/preview', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ fileId: objectId, mapping: mappingSchema.default({}), options: optionsSchema.optional(), classification: classificationSchema.optional() }).parse(req.body);
  res.json(await previewFile(b.fileId, b));
}));

router.post('/cdr/process', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ fileId: objectId, mapping: mappingSchema, options: optionsSchema.optional(), classification: classificationSchema, reportDate: isoDate.optional(), saveMappingAs: z.string().min(1).max(80).optional(), replace: z.boolean().optional() }).parse(req.body);
  res.json({ file: await processFile(b.fileId, b, req.user) });
}));

router.get('/cdr/files', asyncH(async (req, res) => {
  const files = await UploadedCDR.find().select('-storedName -sha256').sort({ createdAt: -1 }).limit(500).lean();
  res.json({ files });
}));

router.get('/cdr/files/:id', asyncH(async (req, res) => {
  const file = await UploadedCDR.findById(objectId.parse(req.params.id)).select('-storedName').lean();
  if (!file) return res.status(404).json({ error: 'File not found' });
  res.json({ file });
}));

router.delete('/cdr/files/:id', requireRole('admin'), asyncH(async (req, res) => {
  await deleteFile(objectId.parse(req.params.id), req.user);
  res.json({ ok: true });
}));

router.get('/cdr/mappings', asyncH(async (req, res) => res.json({ mappings: await ColumnMapping.find().sort({ updatedAt: -1 }).lean(), fields: REPORT_FIELDS.map(({ key, label, required }) => ({ key, label, required })) })));

// ---------- Dashboard ----------
router.get('/dashboard/summary', asyncH(async (req, res) => {
  const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional(), agents: z.string().max(5000).optional() }).parse(req.query);
  res.json(await dashboardSummary({ dateFrom: q.dateFrom, dateTo: q.dateTo, agents: q.agents ? q.agents.split('|').filter(Boolean) : [] }));
}));
router.get('/dashboard/agents', asyncH(async (req, res) => {
  const fileIds = (await UploadedCDR.find({ status: 'processed' }).select('_id').lean()).map((f) => f._id);
  res.json({ agents: (await CdrRecord.distinct('agentName', { fileId: { $in: fileIds }, valid: true })).sort() });
}));

// ---------- Reports ----------
const reportListFields = '-data.agents -data.quality -data.notes';

router.post('/reports/generate', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ fileId: objectId, reportDate: isoDate, restrictToDate: z.boolean().default(true) }).parse(req.body);
  const doc = await generateReport({ type: 'single', fileIds: [b.fileId], reportDate: b.reportDate, restrictToDate: b.restrictToDate, userId: req.user.id });
  res.status(201).json({ report: doc.toObject() });
}));

router.post('/reports/generate-combined', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ fileIds: z.array(objectId).min(1).max(100), dateFrom: isoDate, dateTo: isoDate, reportDate: isoDate.optional() }).parse(req.body);
  const doc = await generateReport({ type: 'combined', fileIds: [...new Set(b.fileIds)], dateFrom: b.dateFrom, dateTo: b.dateTo, reportDate: b.reportDate, userId: req.user.id });
  res.status(201).json({ report: doc.toObject() });
}));

router.get('/reports', asyncH(async (req, res) => {
  const reports = await GeneratedReport.find().select(reportListFields).sort({ createdAt: -1 }).limit(300).lean();
  res.json({ reports });
}));

router.get('/reports/:id', asyncH(async (req, res) => {
  const report = await GeneratedReport.findById(objectId.parse(req.params.id)).lean();
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const deliveries = await DeliveryLog.find({ reportId: report._id }).sort({ createdAt: -1 }).lean();
  res.json({ report, deliveries, messagePreview: buildMessageText(report.data, 'both') });
}));

function sendStored(res, area, name, downloadName, type) {
  const p = storagePath(area, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on server' });
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(p, downloadName);
}
const dlName = (r, ext) => `Tata_Dialer_Agent_Report_${String(r.reportDate).replace(/[^0-9A-Za-z_-]+/g, '_')}_${r.type}.${ext}`;

router.get('/reports/:id/excel', asyncH(async (req, res) => {
  const r = await GeneratedReport.findById(objectId.parse(req.params.id)).select('excelFile reportDate type').lean();
  if (!r?.excelFile) return res.status(404).json({ error: 'Workbook not found' });
  sendStored(res, 'reports', r.excelFile, dlName(r, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}));

router.get('/reports/:id/image', asyncH(async (req, res) => {
  const r = await GeneratedReport.findById(objectId.parse(req.params.id)).select('imageFile imageStatus imageError reportDate type').lean();
  if (!r) return res.status(404).json({ error: 'Report not found' });
  if (r.imageStatus !== 'ready') return res.status(409).json({ error: r.imageError || 'Image not rendered' });
  if (!r.imageFile) return res.status(404).json({ error: 'The PNG file is missing from server storage. A manager can re-render it from this report.' });
  const imagePath = storagePath('reports', r.imageFile);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'The PNG file is missing from server storage. A manager can re-render it from this report.' });
  if (req.query.inline === '1') {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(imagePath);
  }
  sendStored(res, 'reports', r.imageFile, dlName(r, 'png'), 'image/png');
}));

router.post('/reports/:id/image/render', requireRole('manager'), asyncH(async (req, res) => {
  res.json({ report: (await retryImage(objectId.parse(req.params.id))).toObject() });
}));

router.post('/reports/:id/send', requireRole('manager'), asyncH(async (req, res) => {
  const b = z.object({ destinationIds: z.array(objectId).min(1).max(50), attachments: z.enum(['excel', 'png', 'both']).default('both'), force: z.boolean().default(false) }).parse(req.body);
  const results = await sendReport(objectId.parse(req.params.id), { ...b, userId: req.user.id, trigger: 'manual' });
  res.json({ results });
}));

// ---------- WhatsApp ----------
router.get('/whatsapp/status', asyncH(async (req, res) => res.json({ capabilities: await wa.capabilities() })));

router.get('/whatsapp/groups', asyncH(async (req, res) => {
  try {
    res.json({ groups: await wa.listGroups() });
  } catch (e) {
    if (e instanceof wa.ProviderError) return res.status(502).json({ error: e.message });
    throw e;
  }
}));

// Gateway sessions (Nexsahay). API keys are never sent to the browser.
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'invalid session id');
const providerErr = (res, e) => { if (e instanceof wa.ProviderError) return res.status(502).json({ error: e.message }); throw e; };

router.get('/whatsapp/sessions', asyncH(async (req, res) => {
  try {
    const caps = await wa.capabilities();
    res.json({ sessions: caps.sessions || [], selectedSessionId: caps.selectedSessionId, activeSession: caps.activeSession, connectionError: caps.connectionError });
  } catch (e) { return providerErr(res, e); }
}));

router.get('/whatsapp/sessions/:id', requireRole('admin'), asyncH(async (req, res) => {
  try {
    const s = await wa.getSession(sessionId.parse(req.params.id));
    if (!s) return res.status(404).json({ error: 'Session not found on the gateway' });
    const qr = typeof s.qr === 'string' && s.qr.startsWith('data:image/') ? s.qr : null;
    res.json({ session: { id: s.id, name: s.name, status: s.status, qr } });
  } catch (e) { return providerErr(res, e); }
}));

router.put('/whatsapp/session', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({ sessionId: sessionId.nullable() }).parse(req.body);
  if (b.sessionId) {
    try {
      const all = await wa.listSessions();
      if (!all.some((s) => s.id === b.sessionId)) return res.status(404).json({ error: 'That session does not exist on the gateway.' });
    } catch (e) { return providerErr(res, e); }
  }
  await wa.setSelectedSession(b.sessionId, req.user.id);
  await audit(req.user.id, 'whatsapp.session.select', b.sessionId || 'auto');
  res.json({ capabilities: await wa.capabilities() });
}));

router.get('/whatsapp/messages', requireRole('manager'), asyncH(async (req, res) => {
  try {
    const msgs = await wa.listMessages({ pageSize: 20 });
    res.json({ messages: msgs.map((m) => ({ id: m.id, to: m.remoteJid || m.to || null, body: typeof m.body === 'string' ? m.body.slice(0, 300) : null, type: m.type || null, status: m.status || null, at: m.timestamp || m.createdAt || null })) });
  } catch (e) { return providerErr(res, e); }
}));

const testLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
router.post('/whatsapp/test', requireRole('admin'), testLimiter, asyncH(async (req, res) => {
  const b = z.object({ destinationId: objectId.optional(), to: z.string().min(5).max(120).optional(), message: z.string().min(1).max(1000) }).refine((x) => x.destinationId || x.to, 'Choose a destination or enter a number/JID').parse(req.body);
  let dest;
  if (b.destinationId) {
    dest = await Destination.findById(b.destinationId).lean();
    if (!dest) return res.status(404).json({ error: 'Destination not found' });
  } else {
    const to = b.to.trim();
    dest = { kind: to.endsWith('@g.us') ? 'group' : 'individual', address: to.endsWith('@g.us') ? to : to.replace(/\D/g, ''), label: to };
    if (dest.kind === 'individual' && !/^\d{10,15}$/.test(dest.address)) return res.status(400).json({ error: 'Enter the number with country code and no +, e.g. 919812345678, or a group JID ending in @g.us' });
  }
  try {
    const r = await wa.sendMessage(dest, { text: b.message });
    await audit(req.user.id, 'whatsapp.test', dest.label || dest.address, { messageId: r.id });
    res.json({ ok: true, messageId: r.id, status: r.status, to: dest.label || dest.address });
  } catch (e) {
    await audit(req.user.id, 'whatsapp.test.failed', dest.label || dest.address, { error: e.message });
    return providerErr(res, e);
  }
}));

router.get('/whatsapp/destinations', asyncH(async (req, res) => {
  res.json({ destinations: await Destination.find().select('-verificationCode').sort({ createdAt: 1 }).lean() });
}));

router.post('/whatsapp/destinations', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({ label: z.string().min(1).max(80), kind: z.enum(['individual', 'group']), address: z.string().min(5).max(120) }).parse(req.body);
  let address = b.address.trim();
  if (b.kind === 'individual') {
    address = address.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(address)) return res.status(400).json({ error: 'Enter the number in international format with country code, e.g. 919812345678' });
  } else {
    if (!address.endsWith('@g.us') && !address.includes('@')) address = `${address}@g.us`;
  }

  const isNexsahay = config.whatsapp.provider === 'nexsahay';
  // Nexsahay individuals: the gateway sends from your own linked number, so no opt-in code is needed.
  let verified = isNexsahay && b.kind === 'individual';
  let verifiedAt = verified ? new Date() : undefined;
  let code = null;
  let groupCheckError = null;

  if (b.kind === 'group' && isNexsahay) {
    // Only mark a group ready when the gateway confirms the linked number can see it.
    try {
      const info = await wa.getGroupInfo(address);
      if (info?.subject && (!b.label || b.label === address)) b.label = info.subject;
      verified = true;
      verifiedAt = new Date();
    } catch (e) {
      groupCheckError = e.message;
    }
  } else if (b.kind === 'individual' && !isNexsahay) {
    code = newVerificationCode();
  }

  const d = await Destination.create({
    label: b.label,
    kind: b.kind,
    address,
    verified,
    verifiedAt,
    createdBy: req.user.id,
    ...(code && { verificationCode: hashCode(code), verificationExpiresAt: new Date(Date.now() + 24 * 3600 * 1000) }),
  });
  await audit(req.user.id, 'destination.create', String(d._id), { kind: b.kind });

  res.status(201).json({
    destination: { ...d.toObject(), verificationCode: undefined },
    verification: isNexsahay
      ? { instructions: b.kind === 'individual' ? 'Recipient is ready to receive reports.' : verified ? 'Group confirmed by the gateway and ready to receive reports.' : `Saved, but the group could not be confirmed yet: ${groupCheckError} Connect the WhatsApp session, then click "Verify".` }
      : (code
        ? { code, instructions: `From WhatsApp number +${address}, send the message "VERIFY ${code}" to the business number ${config.whatsapp.businessNumberDisplay || '(your WhatsApp Business number)'} within 24 hours.` }
        : { instructions: 'Click "Verify group" to confirm this group ID belongs to your business number via the Groups API.' }),
  });
}));

router.post('/whatsapp/destinations/:id/regenerate-code', requireRole('admin'), asyncH(async (req, res) => {
  const d = await Destination.findById(objectId.parse(req.params.id));
  if (!d || d.kind !== 'individual') return res.status(404).json({ error: 'Destination not found' });
  const code = newVerificationCode();
  Object.assign(d, { verificationCode: hashCode(code), verificationExpiresAt: new Date(Date.now() + 24 * 3600 * 1000) });
  await d.save();
  res.json({ verification: { code, instructions: `From +${d.address}, send "VERIFY ${code}" to ${config.whatsapp.businessNumberDisplay || 'your WhatsApp Business number'} within 24 hours.` } });
}));

router.post('/whatsapp/destinations/:id/verify-group', requireRole('admin'), asyncH(async (req, res) => {
  const d = await Destination.findById(objectId.parse(req.params.id));
  if (!d || d.kind !== 'group') return res.status(404).json({ error: 'Group destination not found' });
  try {
    const info = await wa.getGroupInfo(d.address);
    Object.assign(d, { verified: true, verifiedAt: new Date(), label: d.label || info.subject });
    await d.save();
    await audit(req.user.id, 'destination.verified', String(d._id), { via: 'group api' });
    res.json({ destination: d.toObject(), group: { subject: info.subject } });
  } catch (e) {
    res.status(422).json({ error: `Could not verify group: ${e.message}` });
  }
}));

router.delete('/whatsapp/destinations/:id', requireRole('admin'), asyncH(async (req, res) => {
  await Destination.deleteOne({ _id: objectId.parse(req.params.id) });
  await audit(req.user.id, 'destination.delete', req.params.id);
  res.json({ ok: true });
}));

// ---------- Schedule ----------
async function scheduleView() {
  const s = (await getSchedule()).toObject();
  return { schedule: s, cron: cronFor(s), nextRunAt: nextRun(s), whatsappConfigured: whatsappConfigured() };
}
router.get('/settings/schedule', asyncH(async (req, res) => res.json(await scheduleView())));

router.put('/settings/schedule', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(60).refine((tz) => { try { Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'unknown timezone'),
    frequency: z.enum(['daily', 'weekdays', 'custom']),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    reportDay: z.enum(['today', 'previous', 'fixed']),
    fixedDate: isoDate.nullable().optional(),
    mode: z.enum(['single', 'combined']),
    fileIds: z.array(objectId).max(100).default([]),
    attachments: z.enum(['excel', 'png', 'both']),
    destinationIds: z.array(objectId).max(50),
  }).parse(req.body);
  if (b.frequency === 'custom' && !b.days.length) return res.status(400).json({ error: 'Select at least one day for a custom schedule.' });
  if (b.reportDay === 'fixed' && !b.fixedDate) return res.status(400).json({ error: 'Choose the fixed report date.' });
  // Older schedules can retain IDs for destinations that were deleted or recreated.
  // Ignore those stale IDs so they do not prevent saving the current valid selection.
  b.destinationIds = [...new Set(b.destinationIds)];
  const dests = await Destination.find({ _id: { $in: b.destinationIds } }).lean();
  const bad = dests.filter((d) => !d.verified);
  if (bad.length) return res.status(422).json({ error: `Only verified destinations can be scheduled. Not verified: ${bad.map((d) => d.label).join(', ')}` });
  b.destinationIds = dests.map((d) => String(d._id));
  const s = await getSchedule();
  Object.assign(s, b, { updatedBy: req.user.id });
  await s.save();
  await reloadSchedule();
  await audit(req.user.id, 'schedule.update', 'default', b);
  res.json(await scheduleView());
}));

router.post('/settings/schedule/test', requireRole('admin'), asyncH(async (req, res) => {
  const result = await executeSchedule({ test: true });
  res.json({ result, ...(await scheduleView()) });
}));

// ---------- Team motivation messages (good morning / end of day to the WhatsApp group) ----------
const motivationMsg = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  mode: z.enum(['predefined', 'ai', 'custom']),
  text: z.string().max(1000).nullable().optional(),
  variant: z.number().int().min(0).max(9).nullable().optional(),
});
const motivationView = async () => {
  const cfg = await mot.getConfig();
  return { config: cfg, nextRuns: mot.nextRuns(cfg), history: await mot.history(50), aiEnabled: mot.aiEnabled() };
};

router.get('/motivation', asyncH(async (req, res) => res.json(await motivationView())));

router.put('/motivation', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({
    enabled: z.boolean(),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    destinationId: z.string().regex(/^[a-f\d]{24}$/).nullable(),
    morning: motivationMsg,
    eod: motivationMsg,
  }).parse(req.body);
  const withText = (m) => ({ ...m, text: m.text?.trim() || '' });
  await mot.saveConfig({ ...b, workingDays: [...new Set(b.workingDays)].sort(), morning: withText(b.morning), eod: withText(b.eod) }, req.user.id);
  res.json(await motivationView());
}));

router.post('/motivation/preview', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({ type: z.enum(['morning', 'eod']), mode: z.enum(['predefined', 'ai', 'custom']), text: z.string().max(1000).optional(), variant: z.number().int().min(0).max(9).nullable().optional() }).parse(req.body);
  res.json({ text: await mot.composeText(b.type, { mode: b.mode, text: b.text, variant: b.variant }) });
}));

router.post('/motivation/send', requireRole('admin'), asyncH(async (req, res) => {
  const b = z.object({ type: z.enum(['morning', 'eod', 'test']), text: z.string().max(1000).optional() }).parse(req.body);
  const log = await mot.sendNow({ ...b, userId: req.user.id });
  res.status(log.status === 'accepted' ? 201 : 200).json({ log, ...(await motivationView()) });
}));

// ---------- Delivery logs ----------
router.get('/delivery-logs', asyncH(async (req, res) => {
  const q = z.object({ status: z.string().max(20).optional(), reportId: objectId.optional() }).parse(req.query);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.reportId) filter.reportId = q.reportId;
  const logs = await DeliveryLog.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ logs, retryPolicy: config.retry });
}));

router.post('/delivery-logs/:id/retry', requireRole('manager'), asyncH(async (req, res) => {
  res.json({ log: (await retryDelivery(objectId.parse(req.params.id), req.user.id)).toObject() });
}));

export default router;
