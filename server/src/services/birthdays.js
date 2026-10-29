import crypto from 'node:crypto';
import { config } from '../config.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { BirthdaySettings, BirthdaySend, Destination, Employee, EmployeeBirthdaySchedule } from '../models/index.js';
import * as wa from '../whatsapp/index.js';

dayjs.extend(utc); dayjs.extend(timezone);

export function cloudinaryConfigured() {
  const c = config.cloudinary;
  return Boolean(c.cloudName && c.apiKey && c.apiSecret);
}

export async function uploadEmployeePhoto(file) {
  if (!cloudinaryConfigured()) throw Object.assign(new Error('Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the server first.'), { status: 503 });
  if (!file?.buffer || !file.mimetype?.startsWith('image/')) throw Object.assign(new Error('Choose an image file.'), { status: 415 });
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'tata-dialer/employees';
  const sign = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${config.cloudinary.apiSecret}`).digest('hex');
  const body = new FormData();
  body.set('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  body.set('api_key', config.cloudinary.apiKey); body.set('timestamp', String(timestamp)); body.set('folder', folder); body.set('signature', sign);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary.cloudName)}/image/upload`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) throw Object.assign(new Error(data.error?.message || 'Cloudinary photo upload failed.'), { status: 502 });
  return { imageUrl: data.secure_url, imagePublicId: data.public_id };
}

export async function getBirthdaySettings() {
  let settings = await BirthdaySettings.findOne({ key: 'default' });
  if (!settings) settings = await BirthdaySettings.create({ key: 'default' });
  const preferredGroup = await Destination.findOne({ kind: 'group', verified: true, label: /^Test Controller$/i }).sort({ createdAt: 1 });
  let changed = false;
  if (preferredGroup) {
    const currentGroup = settings.destinationId ? await Destination.findOne({ _id: settings.destinationId, kind: 'group', verified: true }).lean() : null;
    if (!currentGroup || /^Nexsahay Team$/i.test(currentGroup.label)) {
      settings.destinationId = preferredGroup._id;
      if (!currentGroup) settings.enabled = true;
      changed = true;
    }
  }
  if (settings.time !== '00:00') { settings.time = '00:00'; changed = true; }
  const defaultGreeting = 'Happy Birthday, {name}! 🎂🎉 Wishing you a wonderful year ahead!';
  const previousGreeting = '🎂 *Happy Birthday, {name}!*\n\nWishing you a wonderful day filled with happiness and a year ahead full of success! 🎉';
  if (settings.message === defaultGreeting || settings.message === previousGreeting) {
    settings.message = `🎂 *Happy Birthday, {name}!*\n\nWishing you a wonderful day filled with happiness, laughter, and the people you love. Your dedication, positivity, and contribution mean so much to our team, and we’re grateful to have you with us.\n\nMay the year ahead bring you good health, new opportunities, success, and many moments to celebrate. Enjoy your special day—you deserve it! 🎉🥳`;
    changed = true;
  }
  if (changed) await settings.save();
  return settings;
}

export async function sendBirthday(employee, destination, { dateKey = new Date().toISOString().slice(0, 10), messageTemplate = '' } = {}) {
  const message = (messageTemplate || 'Happy Birthday, {name}! 🎂🎉 Wishing you a wonderful year ahead!').replaceAll('{name}', employee.name);
  let log;
  try {
    log = await BirthdaySend.create({ employeeId: employee._id, employeeName: employee.name, dateKey, destinationId: destination._id, destinationLabel: destination.label, status: 'sending', message });
  } catch (e) {
    if (e.code === 11000) return { status: 'skipped', message: `${employee.name} was already sent for ${dateKey}.` };
    throw e;
  }
  try {
    const url = new URL(employee.imageUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'cloudinary.com' || url.hostname.endsWith('.cloudinary.com'))) throw new Error('Employee photo URL is not a secure Cloudinary image.');
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('Could not fetch the employee photo from Cloudinary.');
    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mimeType.startsWith('image/')) throw new Error('Cloudinary did not return an image.');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 16 * 1024 * 1024) throw new Error('Employee image exceeds the WhatsApp 16 MB image limit.');
    const imageResult = await wa.sendMedia(destination, { buffer, mimeType, filename: `${employee.name.replace(/[^a-z0-9_-]/gi, '_')}-birthday`, type: 'image' });
    log.imageMessageId = imageResult.id;
    await log.save();
    try {
      const textResult = await wa.sendMessage(destination, message);
      Object.assign(log, { status: 'accepted', providerMessageId: imageResult.id, textMessageId: textResult.id, sentAt: new Date() });
    } catch (e) {
      Object.assign(log, { status: 'partial', providerMessageId: imageResult.id, error: `Birthday photo sent, but the text message failed: ${e.message}`, sentAt: new Date() });
    }
    await log.save();
    return log;
  } catch (e) {
    log.status = 'failed'; log.error = e.message; await log.save();
    return log;
  }
}

export async function birthdayTick(now = new Date()) {
  await processBirthdaySchedules(now);
  const settings = await getBirthdaySettings();
  if (!settings.enabled || !settings.destinationId) return;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  if (time < settings.time) return;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [, month, day] = parts.split('-');
  const employees = await Employee.find({ dob: { $regex: `^\\d{4}-${month}-${day}$` } }).lean();
  if (!employees.length) return;
  const destination = await Destination.findOne({ _id: settings.destinationId, kind: 'group', verified: true }).lean();
  if (!destination) return;
  for (const employee of employees) await sendBirthday(employee, destination, { dateKey: parts, messageTemplate: settings.message });
}

export async function scheduleBirthday({ employee, destination, date, time, message, userId }) {
  const sendAt = dayjs.tz(`${date}T${time}:00`, config.timezone);
  if (!sendAt.isValid() || !sendAt.isAfter(dayjs())) throw Object.assign(new Error('Choose a future date and time.'), { status: 400 });
  return EmployeeBirthdaySchedule.create({ employeeId: employee._id, destinationId: destination._id, employeeName: employee.name, destinationLabel: destination.label, message: message || 'Happy Birthday, {name}! 🎂🎉 Wishing you a wonderful year ahead!', sendAt: sendAt.toDate(), requestedBy: userId });
}

export async function processBirthdaySchedules(now = new Date()) {
  const due = await EmployeeBirthdaySchedule.find({ status: 'pending', sendAt: { $lte: now } }).select('_id').limit(50).lean();
  for (const item of due) {
    const locked = await EmployeeBirthdaySchedule.findOneAndUpdate({ _id: item._id, status: 'pending' }, { status: 'sending' }, { new: true });
    if (!locked) continue;
    try {
      const [employee, destination] = await Promise.all([Employee.findById(locked.employeeId), Destination.findOne({ _id: locked.destinationId, kind: 'group', verified: true })]);
      if (!employee || !destination) throw new Error('Employee or verified WhatsApp group is no longer available.');
      const dateKey = `${dayjs(locked.sendAt).tz(config.timezone).format('YYYY-MM-DD')}-scheduled-${locked._id}`;
      const result = await sendBirthday(employee, destination, { dateKey, messageTemplate: locked.message });
      locked.status = ['accepted', 'partial'].includes(result.status) ? result.status : 'failed';
      locked.error = result.error || (result.status === 'failed' ? 'WhatsApp did not accept the message.' : undefined);
      locked.sentAt = result.sentAt; locked.birthdaySendId = result._id;
    } catch (e) { locked.status = 'failed'; locked.error = e.message; }
    await locked.save();
  }
}

export async function birthdayView() {
  const [settings, employees, groups, sends] = await Promise.all([
    getBirthdaySettings(), Employee.find().sort({ name: 1 }).lean(),
    Destination.find({ kind: 'group', verified: true }).select('label').sort({ label: 1 }).lean(),
    BirthdaySend.find().sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  const schedules = await EmployeeBirthdaySchedule.find().sort({ sendAt: -1 }).limit(100).lean();
  return { settings, employees, groups, sends, schedules, timezone: config.timezone, cloudinaryConfigured: cloudinaryConfigured() };
}
