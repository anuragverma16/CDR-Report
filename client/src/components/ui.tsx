import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const ALERT = {
  info: { cls: 'border-blue-200 bg-blue-50 text-blue-900', Icon: Info },
  success: { cls: 'border-green-200 bg-green-50 text-green-900', Icon: CheckCircle2 },
  warning: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: AlertTriangle },
  error: { cls: 'border-red-200 bg-red-50 text-red-900', Icon: XCircle },
};
export function Alert({ kind = 'info', title, children }: { kind?: keyof typeof ALERT; title?: string; children?: ReactNode }) {
  const { cls, Icon } = ALERT[kind];
  return (
    <div className={`fade-in flex gap-3 rounded-lg border px-4 py-3 text-sm ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className="break-words">{children}</div>}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  green: 'bg-green-100 text-green-800',
  blue: 'bg-blue-100 text-blue-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  slate: 'bg-slate-100 text-slate-700',
  maroon: 'bg-rose-100 text-rose-900',
};
export function Badge({ tone = 'slate', children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONE[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof TONE> = {
  processed: 'green', uploaded: 'blue', processing: 'amber', failed: 'red',
  delivered: 'green', read: 'green', accepted: 'blue', sent: 'green', sending: 'amber', queued: 'slate', partial: 'amber', pending: 'slate',
  not_sent: 'slate', success: 'green', generated: 'blue', ready: 'green',
};
const STATUS_LABEL: Record<string, string> = { accepted: 'accepted by WhatsApp', not_sent: 'not sent' };
export function StatusBadge({ status }: { status?: string }) {
  if (!status) return <Badge>—</Badge>;
  return <Badge tone={STATUS_TONE[status] || 'slate'}>{STATUS_LABEL[status] || status}</Badge>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-slate-300">{icon}</div>}
      <div className="font-semibold text-slate-700">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Section({ title, children, actions, className = '' }: { title: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card fade-in ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <h2 className="font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
