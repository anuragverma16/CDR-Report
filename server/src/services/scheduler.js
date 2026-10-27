import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { ReportSchedule, ScheduleRun, UploadedCDR, GeneratedReport, audit } from '../models/index.js';
import { config, mysqlConfigured } from '../config.js';
import { fetchLiveReport } from './mysqlSource.js';
import { generateReport } from './reportService.js';
import { sendReport, processDueRetries } from './deliveryService.js';
import { motivationTick } from './motivation.js';

dayjs.extend(utc);
dayjs.extend(timezone);

let mainTasks = [];
let retryTask = null;
let motivationTask = null;

/** The run times of a schedule ("HH:mm"), earliest first. A schedule can run several times a day. */
export function scheduleTimes(s) {
  const list = s.times?.length ? s.times : [s.time];
  return [...new Set(list)].sort();
}

export function cronFor(s, time = scheduleTimes(s)[0]) {
  const [h, m] = time.split(':').map(Number);
  const dow = s.frequency === 'daily' ? '*' : s.frequency === 'weekdays' ? '1-5' : (s.days?.length ? [...s.days].sort().join(',') : '*');
  return `${m} ${h} * * ${dow}`;
}

export const cronsFor = (s) => scheduleTimes(s).map((t) => cronFor(s, t));

function nextRunAt(s, time, from) {
  const [h, m] = time.split(':').map(Number);
  const allowed = s.frequency === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : s.frequency === 'weekdays' ? [1, 2, 3, 4, 5] : s.days || [];
  if (!allowed.length) return null;
  let d = dayjs(from).tz(s.timezone).hour(h).minute(m).second(0).millisecond(0);
  for (let i = 0; i < 8; i++) {
    if (d.isAfter(dayjs(from)) && allowed.includes(d.day())) return d.toDate();
    d = d.add(1, 'day').hour(h).minute(m);
  }
  return null;
}

/** Earliest upcoming run across all of the schedule's times. */
export function nextRun(s, from = new Date()) {
  if (!s.enabled) return null;
  const next = scheduleTimes(s).map((t) => nextRunAt(s, t, from)).filter(Boolean);
  return next.length ? new Date(Math.min(...next.map((d) => d.getTime()))) : null;
}

export async function getSchedule() {
  let s = await ReportSchedule.findOne({ key: 'default' });
  if (!s) s = await ReportSchedule.create({ key: 'default' });
  return s;
}

function reportDateFor(s, now = new Date()) {
  if (s.reportDay === 'fixed') return s.fixedDate;
  const d = dayjs(now).tz(s.timezone);
  return (s.reportDay === 'previous' ? d.subtract(1, 'day') : d).format('YYYY-MM-DD');
}

/** Pick processed files that contain records for `date`. Explicit selection wins when set. */
async function filesFor(s, date) {
  const q = { status: 'processed', 'dateRange.from': { $lte: date }, 'dateRange.to': { $gte: date } };
  if (s.fileIds?.length) q._id = { $in: s.fileIds };
  return UploadedCDR.find(q).sort({ processedAt: -1 }).lean();
}

/**
 * One scheduled execution. `runKey` makes it idempotent: a unique index on ScheduleRun guarantees
 * the same slot never runs twice (restart, several instances, or a manual test with the same key).
 */
export async function executeSchedule({ test = false, slot = null } = {}) {
  const s = await getSchedule();
  const now = new Date();
  const date = reportDateFor(s, now);
  const runTime = slot || scheduleTimes(s)[0];
  // one run per time slot per day: a restart or a second instance cannot send the same slot twice
  const runKey = test ? `test:${now.toISOString()}` : `${dayjs(now).tz(s.timezone).format('YYYY-MM-DD')}T${runTime}`;
  try {
    await ScheduleRun.create({ runKey, startedAt: now, status: 'running' });
  } catch (e) {
    if (e.code === 11000) return { skipped: true, message: `Run ${runKey} already executed` };
    throw e;
  }
  const finish = async (status, message, reportId) => {
    await ScheduleRun.updateOne({ runKey }, { finishedAt: new Date(), status, message, reportId });
    Object.assign(s, { lastRunAt: now, lastRunKey: runKey, lastRunStatus: status, lastRunMessage: message, ...(reportId && { lastReportId: reportId }) });
    await s.save();
    await audit(null, test ? 'schedule.test' : 'schedule.run', runKey, { status, message });
    return { status, message, reportId };
  };
  try {
    if (!date) return finish('failed', 'No report date configured (fixed date is empty).');
    let report, sourceNote;
    if (mysqlConfigured()) {
      // Live source: pull the day's calls from MySQL at run time
      ({ report } = await fetchLiveReport({ date, trigger: 'schedule' }));
      report = await GeneratedReport.findById(report._id);
      sourceNote = `MySQL ${config.mysql.database}`;
    } else {
      const files = await filesFor(s, date);
      if (!files.length) return finish('failed', `No processed CDR file contains records for ${date}. Upload and process the CDR file before the scheduled time.`);
      const chosen = s.mode === 'single' ? [files[0]] : files;
      report = await generateReport({ type: s.mode, fileIds: chosen.map((f) => f._id), reportDate: date, dateFrom: date, dateTo: date, trigger: 'schedule' });
      sourceNote = `${chosen.length} file(s)`;
    }
    if (!report.data.quality.reconciliation.slice(0, 4).every((c) => c.ok)) return finish('failed', 'Report totals did not reconcile; nothing was sent.', report._id);
    if (!s.destinationIds?.length) return finish('generated', `Report generated (${report.totalCalls} calls) — no destination configured, nothing sent.`, report._id);
    const attachments = s.attachments !== 'excel' && report.imageStatus !== 'ready' ? 'excel' : s.attachments;
    const results = await sendReport(report._id, { destinationIds: s.destinationIds, attachments, trigger: test ? 'test' : 'schedule' });
    const ok = results.filter((r) => r.status === 'accepted' || r.status === 'delivered').length;
    const note = attachments !== s.attachments ? ' (image unavailable — sent Excel only)' : '';
    return finish(ok === results.length ? 'success' : ok ? 'partial' : 'failed', `Report ${date}: ${report.totalCalls} calls from ${sourceNote}. Accepted by WhatsApp for ${ok}/${results.length} destination(s)${note}. ${results.filter((r) => r.error).map((r) => `${r.destination}: ${r.error}`).join(' ')}`.trim(), report._id);
  } catch (e) {
    return finish('failed', e.message);
  }
}

export async function startScheduler() {
  await reloadSchedule();
  if (!retryTask) retryTask = cron.schedule('* * * * *', () => processDueRetries().catch((e) => console.error('[retry]', e)), { name: 'delivery-retries' });
  if (!motivationTask) motivationTask = cron.schedule('* * * * *', () => motivationTick().catch((e) => console.error('[motivation]', e)), { timezone: config.timezone, name: 'team-motivation' });
}

/** (Re)register the cron job from the schedule stored in MongoDB. Called at boot and after every change. */
export async function reloadSchedule() {
  for (const t of mainTasks) { t.stop(); t.destroy?.(); }
  mainTasks = [];
  const s = await getSchedule();
  if (!s.enabled) return null;
  for (const time of scheduleTimes(s)) {
    mainTasks.push(cron.schedule(cronFor(s, time), () => executeSchedule({ slot: time }).catch((e) => console.error('[schedule]', e)), { timezone: s.timezone, name: `daily-report-${time}` }));
  }
  console.log(`[schedule] active at ${scheduleTimes(s).join(', ')} ${s.timezone}, next ${nextRun(s)?.toISOString()}`);
  return mainTasks;
}
