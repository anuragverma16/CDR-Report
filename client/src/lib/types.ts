export type Role = 'admin' | 'manager' | 'viewer';
export interface User { id: string; email: string; name: string; role: Role }

export type FieldKey = 'agent' | 'callStatus' | 'startTime' | 'startDate' | 'callId' | 'phoneNumber' | 'talkTime' | 'holdTime' | 'wrapUpTime' | 'disposition';
export type Mapping = Partial<Record<FieldKey, string | null>>;
export interface Options { dateOrder: 'DMY' | 'MDY' | 'YMD'; durationFormat: 'auto' | 'seconds' | 'minutes' | 'hms'; agentAliases: Record<string, string> }
export interface Classification {
  status: { answered: string[]; missed: string[] };
  disposition: { interested?: string[]; notInterested?: string[]; callBack?: string[]; answeredDisp?: string[] };
}

export interface UploadedFile {
  _id: string;
  originalName: string;
  fileType: string;
  size: number;
  status: 'uploaded' | 'processing' | 'processed' | 'failed';
  error?: string;
  headers?: string[];
  rowCount?: number;
  mapping?: Mapping;
  options?: Options;
  classification?: Classification;
  reportDate?: string;
  dateRange?: { from: string | null; to: string | null };
  stats?: { totalRows: number; valid: number; invalid: number; duplicatesInFile: number; duplicatesOfImported: number; agents: number };
  createdAt: string;
  processedAt?: string;
}

export interface UploadResult {
  file: UploadedFile;
  error?: string;
  warning?: string | null;
  preview?: PreviewRow[];
  suggestion?: { mapping: Mapping; source: string; options: Options; classification: Classification | null };
}
export interface PreviewRow { rowNumber: number; values: Record<string, string> }
export interface ValueCount { value: string; count: number }

export interface PreviewResponse {
  ok: boolean;
  headers: string[];
  preview: PreviewRow[];
  fields: { key: FieldKey; label: string; required: boolean }[];
  mappingErrors: string[];
  summary?: {
    totalRows: number; valid: number; invalid: number; duplicatesInFile: number; duplicatesOfImported: number; usesCallId: boolean;
    statuses: ValueCount[]; dispositions: ValueCount[]; dates: ValueCount[]; invalidSamples: { row: number; errors: string[] }[]; agents: string[];
  };
  classification?: Classification;
  unclassifiedStatuses?: ValueCount[];
  missingOptionalFields?: string[];
  suggestedReportDate?: string | null;
  normalizedSample?: { row: number; agent: string; date: string | null; status: string; statusLabel: string; disposition: string | null; dispositionClasses: string[]; talkSec: number | null; holdSec: number | null; wrapSec: number | null; valid: boolean; errors: string[]; warnings: string[] }[];
}

export interface AgentRow {
  agent: string; totalCalls: number; answered: number; missed: number; unclassified: number;
  talkSec: number; holdSec: number; wrapSec: number; interested: number; notInterested: number; callBack: number; answeredDisp: number; noDisposition: number; warnings: number;
}
export type Avail = 'full' | 'partial' | 'none';
export interface Availability { talk: Avail; hold: Avail; wrap: Avail; disposition: Avail }
export interface Summary {
  totalCalls: number; answered: number; missed: number; unclassified: number; answerRate: number | null; missedRate: number | null;
  talkSec: number | null; holdSec: number | null; wrapSec: number | null; interested: number | null; notInterested: number | null; callBack: number | null; answeredDisp: number | null; agentCount: number;
}
export interface ReportLayout { holdLabel: string; wrapLabel: string; dispositions: boolean }
export interface ReportData {
  title: string; type: 'single' | 'combined'; reportDate: string; dateFrom: string | null; dateTo: string | null; generatedAt: string;
  agents: AgentRow[]; total: AgentRow; availability: Availability; layout?: ReportLayout; notes: string[]; summary: Summary;
  quality: {
    invalid: { file: string; row: number; errors: string[] }[];
    duplicates: { file: string; row: number; duplicateOfFile: string; duplicateOfRow: number; basis: string }[];
    warnings: { file: string; row: number; agent: string; warnings: string[] }[];
    missingValues: Record<string, number>;
    unmappedStatuses: ValueCount[]; unmappedDispositions: ValueCount[];
    reconciliation: { check: string; expected: number; actual: number; ok: boolean }[];
    allChecksPassed: boolean; outsideRange: number; dispositionsOnMissed: number;
  };
  sources: { fileId: string; name: string; rowsInRange: number; counted: number; duplicates: number; invalid: number }[];
}
export interface Report {
  _id: string; type: 'single' | 'combined'; reportDate: string; dateFrom?: string; dateTo?: string; sourceNames: string[]; agentCount: number; totalCalls: number;
  data: ReportData; imageStatus: 'pending' | 'ready' | 'failed'; imageError?: string; trigger: string;
  deliveryStatus: 'not_sent' | 'sending' | 'sent' | 'partial' | 'failed'; createdAt: string;
}

export interface Destination { _id: string; label: string; kind: 'individual' | 'group'; address: string; verified: boolean; verifiedAt?: string; verificationExpiresAt?: string; lastInboundAt?: string }
export interface DeliveryPart { kind: 'image' | 'document' | 'text'; status: string; providerMessageId?: string; error?: string; errorCode?: string; retryable?: boolean; updatedAt?: string }
export interface DeliveryLog {
  _id: string; reportId: string; destinationLabel: string; destinationAddress: string; provider: string; attachments: string; trigger: string;
  status: 'queued' | 'sending' | 'accepted' | 'delivered' | 'partial' | 'failed'; parts: DeliveryPart[]; attempts: number; nextRetryAt?: string; error?: string;
  messageText?: string; createdAt: string; updatedAt: string; history: { at: string; event: string; detail: string }[];
}
export interface Capabilities {
  provider: string; providerKey?: string; configured: boolean; webhookConfigured: boolean; apiVersion?: string; businessNumber: string | null; messageMode: string;
  connectionError?: string | null;
  serviceUrl?: string; docsUrl?: string; baseUrl?: string; activeSession?: { id: string; name: string; status: string } | null;
  sessions?: GatewaySession[]; selectedSessionId?: string | null; keySource?: 'session' | 'env' | 'none';
  templates?: { image: string | null; document: string | null; language: string }; groupsEnabled: boolean;
  limits: { imageMaxMb: number; documentMaxMb: number; templateWindow: string; groups: string };
}
export interface WhatsAppGroup { jid: string; name: string; phoneNumber?: string | null; isGroup: boolean }
export interface GatewaySession { id: string; name: string; status: string; hasApiKey: boolean }
export interface GatewayMessage { id: string; to: string | null; body: string | null; type: string | null; status: string | null; at: string | null }
export interface Schedule {
  enabled: boolean; time: string; times: string[]; timezone: string; frequency: 'daily' | 'weekdays' | 'custom'; days: number[];
  reportDay: 'today' | 'previous' | 'fixed'; fixedDate?: string | null; mode: 'single' | 'combined'; fileIds: string[];
  attachments: 'excel' | 'png' | 'both'; destinationIds: string[]; lastRunAt?: string; lastRunStatus?: string; lastRunMessage?: string; lastReportId?: string;
}
