import { UploadedCDR, CdrRecord, GeneratedReport, audit } from '../models/index.js';
import { buildReport } from './aggregator.js';
import { buildWorkbook } from './excel.js';
import { renderReportPng } from './image.js';
import { writeStored } from './storage.js';
import { config } from '../config.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Load processed files + their records in import order (processing time, then row number). */
export async function loadRecords(fileIds, { dateFrom, dateTo } = {}) {
  const files = await UploadedCDR.find({ _id: { $in: fileIds } }).lean();
  if (files.length !== fileIds.length) throw httpError(404, 'One or more selected files no longer exist.');
  const notReady = files.filter((f) => f.status !== 'processed');
  if (notReady.length) throw httpError(422, `These files are not processed yet: ${notReady.map((f) => f.originalName).join(', ')}`);
  files.sort((a, b) => new Date(a.processedAt) - new Date(b.processedAt));
  const records = [];
  for (const f of files) {
    const q = { fileId: f._id };
    // invalid rows have no date; keep them so they appear in Data Quality
    if (dateFrom || dateTo) q.$or = [{ valid: false }, { reportDate: { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: dateTo }) } }];
    const recs = await CdrRecord.find(q).sort({ rowNumber: 1 }).lean();
    records.push(...recs);
  }
  return { files, records };
}

/**
 * Generate and persist a report (data + Excel + PNG). The same report object feeds both files.
 * type 'single': one file; type 'combined': several files over a date range.
 */
export async function generateReport({ type, fileIds, reportDate, dateFrom, dateTo, restrictToDate = true, userId, trigger = 'manual', layout }) {
  if (!fileIds?.length) throw httpError(400, 'Select at least one processed CDR file.');
  if (type === 'single' && fileIds.length !== 1) throw httpError(400, 'A single file report uses exactly one file.');
  let from = dateFrom, to = dateTo;
  if (type === 'single' && restrictToDate && reportDate) { from = reportDate; to = reportDate; }
  if (type === 'single' && !restrictToDate) { from = undefined; to = undefined; }
  if (type === 'combined' && (!from || !to)) throw httpError(400, 'A combined report needs a date range.');
  if (from && to && from > to) throw httpError(400, 'Start date is after end date.');

  const { files, records } = await loadRecords(fileIds, { dateFrom: from, dateTo: to });
  const label = reportDate || (from === to ? from : `${from} to ${to}`);
  const report = buildReport({ records, sources: files.map((f) => ({ fileId: String(f._id), name: f.originalName })), reportDate: label, dateFrom: from, dateTo: to, type, layout });
  if (report.total.totalCalls === 0) {
    throw httpError(422, `No valid, unique CDR records found for ${label} in the selected file(s). Check the report date and the file's date range.`);
  }

  const headersByFile = Object.fromEntries(files.map((f) => [String(f._id), f.headers || []]));
  const rawRecords = records.map((r) => ({ ...r, raw: Object.fromEntries((headersByFile[String(r.fileId)] || []).map((h, i) => [h, r.raw?.[i] ?? null])) }));
  const excelBuf = await buildWorkbook(report, rawRecords, { tz: config.timezone });
  const excelFile = await writeStored('reports', 'xlsx', Buffer.from(excelBuf));

  const doc = await GeneratedReport.create({
    type,
    reportDate: label,
    dateFrom: from || null,
    dateTo: to || null,
    fileIds: files.map((f) => f._id),
    sourceNames: files.map((f) => f.originalName),
    agentCount: report.agents.length,
    totalCalls: report.total.totalCalls,
    data: report,
    excelFile,
    generatedBy: userId,
    trigger,
  });

  try {
    const png = await renderReportPng(report, { tz: config.timezone });
    doc.imageFile = await writeStored('reports', 'png', png);
    doc.imageStatus = 'ready';
  } catch (e) {
    doc.imageStatus = 'failed';
    doc.imageError = `PNG rendering failed: ${e.message.split('\n')[0]}. Run "npm run install-browser" on the server.`;
  }
  await doc.save();
  await audit(userId, 'report.generate', String(doc._id), { type, reportDate: label, files: doc.sourceNames, totalCalls: doc.totalCalls, trigger });
  return doc;
}

/** Re-render a failed PNG from the stored report data (no recalculation). */
export async function retryImage(reportId) {
  const doc = await GeneratedReport.findById(reportId);
  if (!doc) throw httpError(404, 'Report not found');
  const png = await renderReportPng(doc.data, { tz: config.timezone });
  doc.imageFile = await writeStored('reports', 'png', png);
  doc.imageStatus = 'ready';
  doc.imageError = null;
  await doc.save();
  return doc;
}

/** Live dashboard numbers straight from processed CDR records. */
export async function dashboardSummary({ dateFrom, dateTo, agents }) {
  const files = await UploadedCDR.find({ status: 'processed' }).select('_id').lean();
  if (!files.length) return { empty: true };
  const { files: f, records } = await loadRecords(files.map((x) => x._id), { dateFrom, dateTo });
  const valid = records.filter((r) => r.valid);
  const report = buildReport({ records: valid, sources: f.map((x) => ({ fileId: String(x._id), name: x.originalName })), reportDate: dateFrom === dateTo ? dateFrom : `${dateFrom || 'start'} to ${dateTo || 'latest'}`, dateFrom, dateTo, type: 'combined', agentFilter: agents });
  return { empty: false, summary: report.summary, total: report.total, agents: report.agents, availability: report.availability, notes: report.notes, sources: report.sources.filter((s) => s.counted > 0), duplicatesSkipped: report.quality.duplicates.length };
}
