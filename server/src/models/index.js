import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

export const ROLES = ['admin', 'manager', 'viewer'];

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, default: 'viewer' },
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { timestamps: true });

const UploadedCDRSchema = new Schema({
  originalName: { type: String, required: true },
  storedName: { type: String, required: true }, // random name inside STORAGE_DIR/uploads, never user-controlled
  fileType: { type: String, enum: ['csv', 'xlsx', 'xls'], required: true },
  size: Number,
  sha256: { type: String, index: true },
  uploadedBy: { type: Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['uploaded', 'processing', 'processed', 'failed'], default: 'uploaded' },
  error: String,
  headers: [String],
  sheetName: String,
  headerRowNumber: Number,
  rowCount: Number,
  mapping: Schema.Types.Mixed,
  options: Schema.Types.Mixed,
  classification: Schema.Types.Mixed,
  reportDate: String,
  dateRange: { from: String, to: String },
  stats: Schema.Types.Mixed, // valid / invalid / duplicates counts at processing time
  source: { type: String, enum: ['upload', 'mysql'], default: 'upload' },
  sourceDate: String, // mysql snapshots: the report date the rows were fetched for
  processedAt: Date,
  processedBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });

/** One normalized CDR row. `raw` keeps the original values for the Raw CDR sheet. */
const CdrRecordSchema = new Schema({
  fileId: { type: Types.ObjectId, ref: 'UploadedCDR', required: true, index: true },
  rowNumber: Number,
  raw: [Schema.Types.Mixed], // original cell values, aligned with UploadedCDR.headers
  agentKey: String,
  agentName: String,
  callId: String,
  phone: String,
  startAt: Date,
  reportDate: { type: String, index: true },
  statusLabel: String,
  statusClass: String,
  dispositionLabel: String,
  dispositionClasses: [String],
  talkSec: Number,
  holdSec: Number,
  wrapSec: Number,
  unmapped: [String],
  missing: [String],
  valid: Boolean,
  errors: [String],
  warnings: [String],
  dedupeKey: { type: String, index: true },
  dedupeBasis: String,
}, { minimize: false, suppressReservedKeysWarning: true });
CdrRecordSchema.index({ fileId: 1, rowNumber: 1 });

const GeneratedReportSchema = new Schema({
  type: { type: String, enum: ['single', 'combined'], required: true },
  reportDate: { type: String, index: true },
  dateFrom: String,
  dateTo: String,
  fileIds: [{ type: Types.ObjectId, ref: 'UploadedCDR' }],
  sourceNames: [String],
  agentCount: Number,
  totalCalls: Number,
  data: Schema.Types.Mixed, // full report object (rows, totals, quality, sources)
  excelFile: String,
  imageFile: String,
  imageStatus: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending' },
  imageError: String,
  generatedBy: { type: Types.ObjectId, ref: 'User' },
  trigger: { type: String, enum: ['manual', 'schedule'], default: 'manual' },
  deliveryStatus: { type: String, enum: ['not_sent', 'sending', 'sent', 'partial', 'failed'], default: 'not_sent' },
}, { timestamps: true });

const ScheduleSchema = new Schema({
  key: { type: String, default: 'default', unique: true },
  enabled: { type: Boolean, default: false },
  time: { type: String, default: '19:00' }, // HH:mm
  timezone: { type: String, default: 'Asia/Kolkata' },
  frequency: { type: String, enum: ['daily', 'weekdays', 'custom'], default: 'daily' },
  days: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0=Sun..6=Sat, for custom
  reportDay: { type: String, enum: ['today', 'previous', 'fixed'], default: 'today' },
  fixedDate: String,
  mode: { type: String, enum: ['single', 'combined'], default: 'combined' },
  fileIds: [{ type: Types.ObjectId, ref: 'UploadedCDR' }], // optional explicit selection; empty = all processed files covering the date
  attachments: { type: String, enum: ['excel', 'png', 'both'], default: 'png' },
  destinationIds: [{ type: Types.ObjectId, ref: 'Destination' }],
  lastRunAt: Date,
  lastRunKey: String,
  lastRunStatus: String,
  lastRunMessage: String,
  lastReportId: { type: Types.ObjectId, ref: 'GeneratedReport' },
  updatedBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });

/** A WhatsApp recipient. Reports are only ever sent to verified destinations. */
const DestinationSchema = new Schema({
  label: { type: String, required: true },
  kind: { type: String, enum: ['individual', 'group'], default: 'individual' },
  address: { type: String, required: true }, // E.164 digits for individuals, Groups-API group id for groups
  verified: { type: Boolean, default: false },
  verificationCode: String,
  verificationExpiresAt: Date,
  verifiedAt: Date,
  lastInboundAt: Date, // opens the 24h customer-service window
  createdBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });
DestinationSchema.index({ kind: 1, address: 1 }, { unique: true });

const DeliveryPartSchema = new Schema({
  kind: { type: String, enum: ['image', 'document', 'text'] },
  status: { type: String, enum: ['pending', 'accepted', 'sent', 'delivered', 'read', 'failed'], default: 'pending' },
  providerMessageId: { type: String, index: true },
  error: String,
  errorCode: String,
  retryable: Boolean,
  updatedAt: Date,
}, { _id: false });

const DeliveryLogSchema = new Schema({
  reportId: { type: Types.ObjectId, ref: 'GeneratedReport', index: true },
  destinationId: { type: Types.ObjectId, ref: 'Destination' },
  destinationLabel: String,
  destinationAddress: String,
  provider: String,
  attachments: String,
  trigger: { type: String, enum: ['manual', 'schedule', 'retry', 'test'] },
  status: { type: String, enum: ['queued', 'sending', 'accepted', 'delivered', 'partial', 'failed'], default: 'queued', index: true },
  parts: [DeliveryPartSchema],
  messageText: String,
  attempts: { type: Number, default: 0 },
  nextRetryAt: Date,
  error: String,
  idempotencyKey: { type: String, index: true },
  requestedBy: { type: Types.ObjectId, ref: 'User' },
  history: [{ at: Date, event: String, detail: String }],
}, { timestamps: true });

const ColumnMappingSchema = new Schema({
  name: { type: String, required: true, unique: true },
  mapping: Schema.Types.Mixed,
  options: Schema.Types.Mixed,
  classification: Schema.Types.Mixed,
  createdBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const AuditLogSchema = new Schema({
  at: { type: Date, default: Date.now, index: true },
  userId: { type: Types.ObjectId, ref: 'User' },
  action: String,
  target: String,
  detail: Schema.Types.Mixed,
});

/** Lock used so a scheduled run executes at most once, even with several server instances. */
const ScheduleRunSchema = new Schema({
  runKey: { type: String, unique: true },
  startedAt: Date,
  finishedAt: Date,
  status: String,
  message: String,
  reportId: { type: Types.ObjectId, ref: 'GeneratedReport' },
});

const AutomationUploadSchema = new Schema({
  originalName: { type: String, required: true }, storedName: { type: String, required: true },
  fileType: { type: String, enum: ['xlsx', 'xls', 'csv'], default: 'xlsx' },
  size: Number, uploadedBy: { type: Types.ObjectId, ref: 'User', required: true },
  sheets: [{ name: String, rowCount: Number, headers: [String] }], expiresAt: { type: Date, index: { expires: 0 } },
}, { timestamps: true });

/** Small key/value settings changed from the UI (e.g. the selected WhatsApp gateway session). */
const SettingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
  updatedBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });

/** One row per team message sent to the group. Scheduled messages are unique per type, day and group. */
const MotivationLogSchema = new Schema({
  type: { type: String, enum: ['morning', 'eod', 'test'], required: true },
  kind: { type: String, enum: ['scheduled', 'manual', 'test'], required: true },
  dateKey: { type: String, required: true },
  destinationId: { type: Types.ObjectId, ref: 'Destination' },
  destinationLabel: String,
  text: String,
  status: { type: String, enum: ['sending', 'accepted', 'failed'], default: 'sending' },
  attempts: { type: Number, default: 0 },
  error: String,
  providerMessageId: String,
  providerStatus: String,
  scheduledFor: Date,
  sentAt: Date,
  nextRetryAt: Date,
  requestedBy: { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });
MotivationLogSchema.index({ type: 1, dateKey: 1, destinationId: 1 }, { unique: true, partialFilterExpression: { kind: 'scheduled' } });
MotivationLogSchema.index({ status: 1, nextRetryAt: 1 });

export const User = model('User', UserSchema);
export const Setting = model('Setting', SettingSchema);
export const MotivationLog = model('MotivationLog', MotivationLogSchema);
export const UploadedCDR = model('UploadedCDR', UploadedCDRSchema);
export const CdrRecord = model('CdrRecord', CdrRecordSchema);
export const GeneratedReport = model('GeneratedReport', GeneratedReportSchema);
export const ReportSchedule = model('ReportSchedule', ScheduleSchema);
export const Destination = model('Destination', DestinationSchema);
export const DeliveryLog = model('DeliveryLog', DeliveryLogSchema);
export const ColumnMapping = model('ColumnMapping', ColumnMappingSchema);
export const AuditLog = model('AuditLog', AuditLogSchema);
export const ScheduleRun = model('ScheduleRun', ScheduleRunSchema);
export const AutomationUpload = model('AutomationUpload', AutomationUploadSchema);

export async function audit(userId, action, target, detail) {
  try { await AuditLog.create({ userId, action, target, detail }); } catch { /* audit must never break a request */ }
}
