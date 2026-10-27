import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw, RotateCw, ScrollText } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { DeliveryLog } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, Empty, PageHeader, Spinner, StatusBadge } from '../components/ui';

export default function DeliveryLogs() {
  const { can } = useAuth();
  const [logs, setLogs] = useState<DeliveryLog[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [policy, setPolicy] = useState<{ maxAttempts: number; delayMinutes: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ logs: DeliveryLog[]; retryPolicy: { maxAttempts: number; delayMinutes: number } }>(`/delivery-logs${filter ? `?status=${filter}` : ''}`);
      setLogs(r.logs); setPolicy(r.retryPolicy);
    } catch (e) { setError(errMsg(e)); }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const retry = async (l: DeliveryLog) => {
    setBusy(l._id);
    setError('');
    try { await api.post(`/delivery-logs/${l._id}/retry`); await load(); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  return (
    <>
      <PageHeader
        title="Delivery Logs"
        subtitle={policy ? `Every WhatsApp attempt with the provider's actual response. Temporary failures retry automatically (up to ${policy.maxAttempts} attempts).` : undefined}
        actions={<>
          <select className="input w-40" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All statuses</option>
            {['delivered', 'accepted', 'partial', 'failed', 'sending'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn-secondary" onClick={load}><RefreshCw className="h-4 w-4" /> Refresh</button>
        </>}
      />
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}
      {!logs ? <Spinner label="Loading…" /> : logs.length === 0 ? <Empty icon={<ScrollText className="h-10 w-10" />} title="No delivery attempts yet" /> : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-100 bg-slate-50"><tr>{['', 'Time', 'Report', 'Destination', 'Trigger', 'Parts', 'Status', 'Attempts', 'Error / next retry', ''].map((h, i) => <th key={i} className="th whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {logs.map((l) => (
                <Fragment key={l._id}>
                  <tr className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="td"><button onClick={() => setOpen(open === l._id ? null : l._id)} aria-label="Details">{open === l._id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                    <td className="td whitespace-nowrap text-xs">{fmtDateTime(l.createdAt)}</td>
                    <td className="td"><Link to={`/reports/${l.reportId}`} className="text-vol underline">open</Link></td>
                    <td className="td whitespace-nowrap">{l.destinationLabel}<div className="font-mono text-xs text-slate-400">{l.destinationAddress}</div></td>
                    <td className="td"><Badge>{l.trigger}</Badge></td>
                    <td className="td whitespace-nowrap">{l.parts.map((p) => <div key={p.kind} className="flex items-center gap-1 text-xs">{p.kind === 'document' ? 'Excel' : p.kind}: <StatusBadge status={p.status} /></div>)}</td>
                    <td className="td"><StatusBadge status={l.status} /></td>
                    <td className="td tabular-nums">{l.attempts}</td>
                    <td className="td max-w-xs text-xs"><div className="text-red-600">{l.error}</div>{l.nextRetryAt && <div className="text-slate-500">Auto-retry {fmtDateTime(l.nextRetryAt)}</div>}</td>
                    <td className="td">{can('manager') && (l.status === 'failed' || l.status === 'partial') && <button className="btn-secondary px-2.5 py-1 text-xs" disabled={busy === l._id} onClick={() => retry(l)}><RotateCw className={`h-3.5 w-3.5 ${busy === l._id ? 'animate-spin' : ''}`} /> Retry failed parts</button>}</td>
                  </tr>
                  {open === l._id && (
                    <tr className="bg-slate-50/70"><td colSpan={10} className="px-6 py-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div><div className="label">Message</div><pre className="whitespace-pre-wrap rounded bg-surface p-3 font-sans text-xs">{l.messageText}</pre></div>
                        <div><div className="label">History</div>
                          <ul className="space-y-1 text-xs">{l.history.map((h, i) => <li key={i}><span className="text-slate-400">{fmtDateTime(h.at)}</span> · <b>{h.event}</b> {h.detail}</li>)}</ul>
                          <div className="label mt-3">Provider message IDs</div>
                          <ul className="font-mono text-xs">{l.parts.map((p) => <li key={p.kind}>{p.kind}: {p.providerMessageId || '—'}{p.errorCode ? ` (code ${p.errorCode}${p.retryable ? ', retryable' : ''})` : ''}</li>)}</ul>
                        </div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
