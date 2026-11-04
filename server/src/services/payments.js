import { Resvg } from '@resvg/resvg-js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { Employee, PaymentEntry, PaymentReportSettings, PaymentReportRun, Destination } from '../models/index.js';
import * as wa from '../whatsapp/index.js';
import { config } from '../config.js';

dayjs.extend(utc); dayjs.extend(timezone);
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const money = (n) => `₹ ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export async function getPaymentReportSettings() {
  let s = await PaymentReportSettings.findOne({ key: 'default' });
  if (!s) s = await PaymentReportSettings.create({ key: 'default' });
  return s;
}

export async function paymentReportView(date = dayjs().tz(config.timezone).format('YYYY-MM-DD')) {
  const [employees, entries, settings, groups, runs] = await Promise.all([
    Employee.find().sort({ team: 1, name: 1 }).lean(), PaymentEntry.find({ date }).sort({ team: 1, employeeName: 1 }).lean(),
    getPaymentReportSettings(), Destination.find({ kind: 'group', verified: true }).select('label').sort({ label: 1 }).lean(),
    PaymentReportRun.find().sort({ date: -1 }).limit(14).lean(),
  ]);
  return { date, timezone: settings.timezone || config.timezone, employees, entries, settings: settings.toObject(), groups, runs };
}

export function buildPaymentReportSvg({ date, employees, entries }) {
  const byKey = new Map(entries.map((e) => [`${e.employeeId}:${e.period}`, Number(e.amount || 0)]));
  const teams = new Map();
  for (const emp of employees) {
    const team = emp.team?.trim() || 'Unassigned';
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(emp);
  }
  let offset = 210;
  const rows = [...teams.entries()].flatMap(([team, members]) => {
    const vals = members.map((e) => ({ e, before: byKey.get(`${e._id}:before_lunch`) || 0, after: byKey.get(`${e._id}:after_lunch`) || 0 }));
    const teamRow = vals.map((v, i) => `<text x="205" y="${i * 48 + 36}" class="name">${esc(v.e.name)}</text><text x="600" y="${i * 48 + 36}" class="num">${money(v.before)}</text><text x="850" y="${i * 48 + 36}" class="num">${money(v.after)}</text><text x="1090" y="${i * 48 + 36}" class="num bold">${money(v.before + v.after)}</text>`).join('');
    const h = members.length * 48 + 44;
    const totalBefore = vals.reduce((a, v) => a + v.before, 0), totalAfter = vals.reduce((a, v) => a + v.after, 0);
    const g = `<g transform="translate(0,${offset})"><rect x="20" y="0" width="1180" height="${h}" rx="12" fill="#e7f2fc"/><rect x="20" y="0" width="165" height="${h}" rx="12" fill="#d6eafa"/><text x="102" y="${Math.max(40, h / 2 - 8)}" class="team" text-anchor="middle">${esc(team)}</text><text x="102" y="${Math.max(64, h / 2 + 24)}" class="small" text-anchor="middle">${members.length} members</text>${teamRow}<line x1="185" y1="${members.length * 48}" x2="1200" y2="${members.length * 48}" stroke="#8bbbe0"/><text x="205" y="${members.length * 48 + 32}" class="name bold">${esc(team)} Total</text><text x="600" y="${members.length * 48 + 32}" class="num bold">${money(totalBefore)}</text><text x="850" y="${members.length * 48 + 32}" class="num bold">${money(totalAfter)}</text><text x="1090" y="${members.length * 48 + 32}" class="num bold">${money(totalBefore + totalAfter)}</text></g>`;
    offset += h + 16; return g;
  });
  const groupsSvg = rows.join('');
  const totalBefore = entries.filter((e) => e.period === 'before_lunch').reduce((a, e) => a + e.amount, 0);
  const totalAfter = entries.filter((e) => e.period === 'after_lunch').reduce((a, e) => a + e.amount, 0);
  const height = Math.max(offset + 130, 420);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1220" height="${height}" viewBox="0 0 1220 ${height}"><rect width="100%" height="100%" fill="#fff"/><style>text{font-family:Arial,sans-serif;fill:#122b50}.title{font-size:48px;font-weight:700}.sub{font-size:22px}.head{font-size:20px;font-weight:700;fill:#fff}.name,.num{font-size:20px}.team{font-size:24px;font-weight:bold}.small{font-size:16px}.bold{font-weight:bold}</style><text x="24" y="64" class="title">DAILY PAYMENT REPORT</text><text x="24" y="104" class="sub">Team Wise  |  Individual Payment  |  Total Summary</text><text x="940" y="58" class="sub">${esc(dayjs.tz(date, 'YYYY-MM-DD', config.timezone).format('DD MMM YYYY (dddd)'))}</text><rect x="20" y="130" width="1180" height="60" rx="8" fill="#173d63"/><text x="205" y="168" class="head">Team Member</text><text x="600" y="168" class="head">Before Lunch</text><text x="850" y="168" class="head">After Lunch</text><text x="1090" y="168" class="head">Total (₹)</text>${groupsSvg}<rect x="20" y="${height - 100}" width="1180" height="78" rx="12" fill="#173d63"/><text x="50" y="${height - 53}" style="font:700 25px Arial;fill:white">GRAND TOTAL</text><text x="600" y="${height - 53}" style="font:700 24px Arial;fill:white">${money(totalBefore)}</text><text x="850" y="${height - 53}" style="font:700 24px Arial;fill:white">${money(totalAfter)}</text><text x="1090" y="${height - 53}" style="font:700 26px Arial;fill:white">${money(totalBefore + totalAfter)}</text></svg>`;
}

export async function sendPaymentReport(date, destinationId) {
  let run = await PaymentReportRun.findOne({ date });
  if (run && run.status === 'accepted') return run;
  if (run) { run.destinationId = destinationId; run.status = 'sending'; run.message = undefined; }
  else {
    try { run = await PaymentReportRun.create({ date, destinationId, status: 'sending' }); }
    catch (e) { if (e.code === 11000) return PaymentReportRun.findOne({ date }); throw e; }
  }
  try {
    const destination = await Destination.findOne({ _id: destinationId, kind: 'group', verified: true }).lean();
    if (!destination) throw new Error('Choose a verified WhatsApp group.');
    const view = await paymentReportView(date);
    const png = new Resvg(buildPaymentReportSvg(view), { fitTo: { mode: 'width', value: 1600 } }).render().asPng();
    const result = await wa.sendMedia(destination, { buffer: png, mimeType: 'image/png', filename: `daily-payment-${date}.png`, caption: `Daily payment report · ${date}` , type: 'image' });
    Object.assign(run, { status: 'accepted', providerMessageId: result.id, message: `Payment report accepted by WhatsApp for ${destination.label}.` });
  } catch (e) { run.status = 'failed'; run.message = e.message; }
  await run.save();
  return run;
}

export async function paymentReportTick(now = new Date()) {
  const settings = await getPaymentReportSettings();
  if (!settings.enabled || !settings.destinationId) return;
  const date = dayjs(now).tz(settings.timezone || config.timezone).format('YYYY-MM-DD');
  const time = dayjs(now).tz(settings.timezone || config.timezone).format('HH:mm');
  if (time < settings.time || settings.lastSentDate === date) return;
  const result = await sendPaymentReport(date, settings.destinationId);
  settings.lastSentDate = date; settings.lastStatus = result.status; settings.lastMessage = result.message; await settings.save();
}
