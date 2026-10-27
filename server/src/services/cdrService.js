import fs from 'node:fs/promises';
import { UploadedCDR, CdrRecord, ColumnMapping, audit } from '../models/index.js';
import { parseCdrFile } from './parser.js';
import { suggestMapping, suggestClassification, REPORT_FIELDS, DEFAULT_OPTIONS } from './mapping.js';
import { normalizeRows, summarizeRecords, validateMapping } from './ingest.js';
import { displayValue } from './normalize.js';
import { storagePath, sha256File, randomName } from './storage.js';
import { config } from '../config.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Small cache so preview → process does not re-parse large files repeatedly.
const cache = new Map();
async function parsedFor(file) {
  const k = String(file._id);
  if (cache.has(k)) return cache.get(k);
  const parsed = await parseCdrFile(storagePath('uploads', file.storedName), file.fileType);
  cache.set(k, parsed);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return parsed;
}

function previewRows(parsed, n = 20) {
  return parsed.rows.slice(0, n).map((r) => ({ rowNumber: r.rowNumber, values: Object.fromEntries(parsed.headers.map((h) => [h, displayValue(r.values[h])])) }));
}

export async function handleUploads(files, user) {
  const results = [];
  for (const f of files) {
    const fileType = f.filename.split('.').pop();
    const sha256 = await sha256File(f.path);
    const identical = await UploadedCDR.findOne({ sha256, status: { $ne: 'failed' } }).lean();
    const doc = await UploadedCDR.create({ originalName: f.originalname.slice(0, 200), storedName: f.filename, fileType, size: f.size, sha256, uploadedBy: user.id });
    try {
      const parsed = await parsedFor(doc);
      doc.headers = parsed.headers;
      doc.rowCount = parsed.rows.length;
      doc.sheetName = parsed.sheetName;
      doc.headerRowNumber = parsed.headerRowNumber;
      await doc.save();
      const presets = await ColumnMapping.find().sort({ updatedAt: -1 }).lean();
      const suggestion = suggestMapping(parsed.headers, presets);
      const preset = suggestion.presetId ? presets.find((p) => String(p._id) === suggestion.presetId) : null;
      results.push({
        file: doc.toObject(),
        preview: previewRows(parsed),
        suggestion: { ...suggestion, options: preset?.options || DEFAULT_OPTIONS, classification: preset?.classification || null },
        warning: [
          parsed.warning,
          identical && `An identical file was already uploaded as "${identical.originalName}". Its records will be detected as duplicates and not counted twice.`,
        ].filter(Boolean).join(' ') || null,
      });
      await audit(user.id, 'cdr.upload', String(doc._id), { name: doc.originalName, rows: doc.rowCount });
    } catch (e) {
      doc.status = 'failed';
      doc.error = e.message;
      await doc.save();
      await fs.unlink(f.path).catch(() => {});
      results.push({ file: doc.toObject(), error: e.message });
    }
  }
  return results;
}

async function loadFile(fileId) {
  const file = await UploadedCDR.findById(fileId);
  if (!file) throw httpError(404, 'File not found');
  if (file.status === 'failed') throw httpError(422, `This file could not be read: ${file.error}`);
  return file;
}

async function existingKeysFor(records, fileId) {
  const keys = [...new Set(records.filter((r) => r.valid).map((r) => r.dedupeKey))];
  const found = new Set();
  for (let i = 0; i < keys.length; i += 5000) {
    const batch = await CdrRecord.distinct('dedupeKey', { dedupeKey: { $in: keys.slice(i, i + 5000) }, fileId: { $ne: fileId }, valid: true });
    batch.forEach((k) => found.add(k));
  }
  return found;
}

export async function previewFile(fileId, { mapping, options, classification }) {
  const file = await loadFile(fileId);
  const parsed = await parsedFor(file);
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const mappingErrors = validateMapping(mapping, parsed.headers);
  const presets = await ColumnMapping.find().sort({ updatedAt: -1 }).lean();
  const base = { fileId, headers: parsed.headers, preview: previewRows(parsed), fields: REPORT_FIELDS.map(({ key, label, required }) => ({ key, label, required })), mappingErrors, suggestedMapping: suggestMapping(parsed.headers, presets).mapping };
  if (mappingErrors.length) return { ...base, ok: false };

  const first = normalizeRows(parsed.rows, { mapping, options: opts, classification: classification || {}, tz: config.timezone });
  const existing = await existingKeysFor(first.records, file._id);
  const summary = summarizeRecords(first.records, existing);
  const suggested = suggestClassification(summary.statuses.map((s) => s.value), summary.dispositions.map((d) => d.value));
  const cls = classification || suggested;
  const { records } = normalizeRows(parsed.rows, { mapping, options: opts, classification: cls, tz: config.timezone });
  const unclassified = summary.statuses.filter((s) => !cls.status?.answered?.includes(s.value) && !cls.status?.missed?.includes(s.value));
  return {
    ...base,
    ok: true,
    summary,
    classification: cls,
    suggestedClassification: suggested,
    unclassifiedStatuses: unclassified,
    missingOptionalFields: REPORT_FIELDS.filter((f) => !f.required && !mapping[f.key]).map((f) => f.label),
    suggestedReportDate: summary.dates.slice().sort((a, b) => b.count - a.count)[0]?.value || null,
    normalizedSample: records.slice(0, 20).map((r) => ({ row: r.rowNumber, agent: r.agentName, start: r.startAt, date: r.reportDate, status: r.statusClass, statusLabel: r.statusLabel, disposition: r.dispositionLabel, dispositionClasses: r.dispositionClasses, talkSec: r.talkSec, holdSec: r.holdSec, wrapSec: r.wrapSec, valid: r.valid, errors: r.errors, warnings: r.warnings })),
  };
}

export async function processFile(fileId, { mapping, options, classification, reportDate, saveMappingAs, replace }, user) {
  const file = await loadFile(fileId);
  if (file.status === 'processed' && !replace) throw httpError(409, 'This file was already processed. Re-process explicitly to replace its records.');
  if (file.status === 'processing') throw httpError(409, 'This file is already being processed.');
  const parsed = await parsedFor(file);
  const errs = validateMapping(mapping, parsed.headers);
  if (errs.length) throw httpError(422, errs.join(' '));
  if (!classification?.status) throw httpError(422, 'Call status classification is required.');
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };

  file.status = 'processing';
  await file.save();
  try {
    const { records } = normalizeRows(parsed.rows, { mapping, options: opts, classification, tz: config.timezone });
    const existing = await existingKeysFor(records, file._id);
    const summary = summarizeRecords(records, existing);
    await CdrRecord.deleteMany({ fileId: file._id });
    const docs = records.map((r, i) => ({ ...r, fileId: file._id, raw: parsed.headers.map((h) => parsed.rows[i].values[h] ?? null) }));
    for (let i = 0; i < docs.length; i += 2000) await CdrRecord.insertMany(docs.slice(i, i + 2000), { ordered: false, lean: true });

    const dates = summary.dates.map((d) => d.value);
    Object.assign(file, {
      status: 'processed',
      error: null,
      mapping,
      options: opts,
      classification,
      reportDate: reportDate || dates[dates.length - 1] || null,
      dateRange: { from: dates[0] || null, to: dates[dates.length - 1] || null },
      stats: { totalRows: summary.totalRows, valid: summary.valid, invalid: summary.invalid, duplicatesInFile: summary.duplicatesInFile, duplicatesOfImported: summary.duplicatesOfImported, agents: summary.agents.length },
      processedAt: new Date(),
      processedBy: user.id,
    });
    await file.save();
    if (saveMappingAs) {
      await ColumnMapping.findOneAndUpdate({ name: saveMappingAs.slice(0, 80) }, { mapping, options: opts, classification, createdBy: user.id }, { upsert: true });
    }
    await audit(user.id, 'cdr.process', String(file._id), file.stats);
    return file.toObject();
  } catch (e) {
    file.status = 'failed';
    file.error = e.message;
    await file.save();
    throw e;
  }
}

/**
 * One-click path used by Report Automation: run a manually uploaded file through the normal
 * Upload CDR pipeline with the auto-detected mapping and classification. Identical content that
 * was already processed is reused, so the same calls are never imported twice.
 */
export async function importForReport(sourcePath, { originalName, fileType }, user) {
  const sha256 = await sha256File(sourcePath);
  const existing = await UploadedCDR.findOne({ sha256, status: 'processed' }).sort({ processedAt: -1 });
  if (existing) return { file: existing.toObject(), reused: true, ...(await previewFile(existing._id, { mapping: existing.mapping, options: existing.options, classification: existing.classification })) };

  const filename = randomName(fileType);
  const dest = storagePath('uploads', filename);
  await fs.copyFile(sourcePath, dest);
  const { size } = await fs.stat(dest);
  const [up] = await handleUploads([{ path: dest, filename, originalname: originalName, size }], user);
  if (up.error) throw httpError(422, up.error);

  const mapping = up.suggestion.mapping;
  const preview = await previewFile(up.file._id, { mapping, options: up.suggestion.options });
  if (!preview.ok) {
    throw httpError(422, `Some required columns could not be matched automatically (${preview.mappingErrors.join(' ')}). Open "Upload CDR" to map this file's columns by hand.`);
  }
  const classification = up.suggestion.classification || preview.classification;
  const file = await processFile(up.file._id, { mapping, options: up.suggestion.options, classification, reportDate: preview.suggestedReportDate }, user);
  return { file, reused: false, ...preview, classification };
}

export async function deleteFile(fileId, user) {
  const file = await UploadedCDR.findById(fileId);
  if (!file) throw httpError(404, 'File not found');
  await CdrRecord.deleteMany({ fileId: file._id });
  await fs.unlink(storagePath('uploads', file.storedName)).catch(() => {});
  cache.delete(String(file._id));
  await file.deleteOne();
  await audit(user.id, 'cdr.delete', String(fileId), { name: file.originalName });
}
