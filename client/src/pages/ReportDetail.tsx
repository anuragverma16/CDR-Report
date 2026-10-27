import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, ImageIcon, RefreshCw } from 'lucide-react';
import { api, apiUrl, downloadFile, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { DeliveryLog, Report } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';
import { ReportTable } from '../components/ReportTable';
import { SendPanel } from '../components/SendPanel';

export default function ReportDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryLog[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [imgKey, setImgKey] = useState(0);
  const [imgUnavailable, setImgUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ report: Report; deliveries: DeliveryLog[]; messagePreview: string }>(`/reports/${id}`);
      setReport(r.report);
      setDeliveries(r.deliveries);
      setMsg(r.messagePreview);
    } catch (e) { setError(errMsg(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const dl = async (kind: 'excel' | 'image') => {
    setBusy(kind);
    try { await downloadFile(`/reports/${id}/${kind}`, `report.${kind === 'excel' ? 'xlsx' : 'png'}`); } catch (e) { if (kind === 'image') setImgUnavailable(true); setError(errMsg(e)); } finally { setBusy(''); }
  };
  const rerender = async () => {
    setBusy('render');
    try { await api.post(`/reports/${id}/image/render`); setImgUnavailable(false); await load(); setImgKey((k) => k + 1); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  if (error && !report) return <Alert kind="error">{error}</Alert>;
  if (!report) return <Spinner label="Loading report…" />;
  const d = report.data;
  const q = d.quality;
  return (
    <>
      <Link to="/live" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink"><ArrowLeft className="h-4 w-4" /> Live Report</Link>
      <PageHeader
        title={`Agent Report · ${d.reportDate}`}
        subtitle={<>{report.type === 'combined' ? 'Combined' : 'Single file'} report · generated {fmtDateTime(d.generatedAt)} · {report.trigger === 'schedule' ? 'scheduled' : 'manual'}</>}
        actions={<>
          <button className="btn-primary" onClick={() => dl('excel')} disabled={!!busy}><Download className="h-4 w-4" /> {busy === 'excel' ? 'Downloading…' : 'Download Excel'}</button>
          {report.imageStatus === 'ready' && !imgUnavailable
            ? <button className="btn-secondary" onClick={() => dl('image')} disabled={!!busy}><ImageIcon className="h-4 w-4" /> {busy === 'image' ? 'Downloading…' : 'Download PNG'}</button>
            : can('manager') && <button className="btn-secondary" onClick={rerender} disabled={!!busy}><RefreshCw className={`h-4 w-4 ${busy === 'render' ? 'animate-spin' : ''}`} /> {busy === 'render' ? 'Rendering…' : 'Render PNG'}</button>}
        </>}
      />
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}
      <div className="mb-4 flex flex-wrap gap-2">
        {q.allChecksPassed ? <Badge tone="green">All reconciliation checks passed</Badge> : <Badge tone="red">Reconciliation needs attention</Badge>}
        <Badge tone="blue">{d.summary.agentCount} agents</Badge>
        <Badge tone="blue">{d.summary.totalCalls} calls</Badge>
        <Badge>Answer rate {d.summary.answerRate ?? 'N/A'}%</Badge>
        <Badge tone={report.imageStatus === 'ready' ? 'green' : report.imageStatus === 'failed' ? 'red' : 'amber'}>PNG: {report.imageStatus}</Badge>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">WhatsApp: <StatusBadge status={report.deliveryStatus} /></span>
      </div>

      <ReportTable title={`${d.title} | Date: ${d.reportDate}`} agents={d.agents} total={d.total} availability={d.availability} layout={d.layout} />
      {(d.notes.length > 0 || [d.availability.talk, d.availability.hold, d.availability.wrap].includes('partial')) && (
        <div className="mt-3 space-y-1 text-xs text-amber-800">
          {d.notes.map((n) => <div key={n}>• {n}</div>)}
          {[d.availability.talk, d.availability.hold, d.availability.wrap].includes('partial') && <div>* Partial value — some counted calls had no value for this metric.</div>}
        </div>
      )}

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
        <Section title="Report image (PNG)">
          {report.imageStatus === 'ready' && !imgUnavailable ? (
            <>
              <a href={apiUrl(`/reports/${id}/image?inline=1`)} target="_blank" rel="noreferrer">
                <img key={imgKey} src={apiUrl(`/reports/${id}/image?inline=1&v=${imgKey}`)} onError={() => setImgUnavailable(true)} alt="Generated agent report" className="w-full rounded-lg border border-slate-200 shadow-sm" />
              </a>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary" onClick={() => dl('image')} disabled={!!busy}><Download className="h-4 w-4" /> {busy === 'image' ? 'Downloading…' : 'Download PNG'}</button>
                <a href={apiUrl(`/reports/${id}/image?inline=1`)} target="_blank" rel="noreferrer" className="btn-secondary">Open full size</a>
              </div>
            </>
          ) : (
            <>
              <Alert kind="warning" title="Image not available">{imgUnavailable ? 'The PNG is missing from server storage or could not be loaded. Re-render the image to restore it.' : report.imageError || 'Rendering pending.'}</Alert>
              {can('manager') && (
                <div className="mt-3">
                  <button className="btn-secondary" onClick={rerender} disabled={!!busy}>
                    <RefreshCw className={`h-4 w-4 ${busy === 'render' ? 'animate-spin' : ''}`} /> {busy === 'render' ? 'Rendering PNG…' : 'Render PNG now'}
                  </button>
                </div>
              )}
            </>
          )}
        </Section>
        <Section title="Send via WhatsApp">
          {can('manager') ? <SendPanel report={report} onSent={load} /> : <Alert kind="info">Only managers and admins can send reports.</Alert>}
          <div className="mt-5"><div className="label">Message preview</div><pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-sm text-slate-700">{msg}</pre></div>
        </Section>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Section title="Reconciliation">
          <table className="w-full"><tbody>
            {q.reconciliation.map((c) => (
              <tr key={c.check} className="border-b border-slate-50"><td className="td">{c.check}</td><td className="td tabular-nums text-right">{c.expected} / {c.actual}</td><td className="td text-right">{c.ok ? <Badge tone="green">PASS</Badge> : <Badge tone="red">FAIL</Badge>}</td></tr>
            ))}
          </tbody></table>
        </Section>
        <Section title="Source files (audit trail)">
          <table className="w-full">
            <thead><tr><th className="th">File</th><th className="th">Counted</th><th className="th">Duplicates</th><th className="th">Invalid</th></tr></thead>
            <tbody>{d.sources.map((s) => <tr key={s.fileId} className="border-b border-slate-50"><td className="td font-medium">{s.name}</td><td className="td tabular-nums">{s.counted}</td><td className="td tabular-nums">{s.duplicates}</td><td className="td tabular-nums">{s.invalid}</td></tr>)}</tbody>
          </table>
          {q.outsideRange > 0 && <p className="mt-2 text-xs text-slate-500">{q.outsideRange} valid record(s) were outside the report period.</p>}
        </Section>
      </div>

      <Section title="Data quality" className="mt-6">
        <div className="grid gap-3 sm:grid-cols-4">
          {[['Invalid rows', q.invalid.length], ['Duplicates skipped', q.duplicates.length], ['Record warnings', q.warnings.length], ['Unmapped statuses', q.unmappedStatuses.reduce((s, x) => s + x.count, 0)]].map(([l, v]) => (
            <div key={l as string} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-bold tabular-nums">{v}</div></div>
          ))}
        </div>
        {q.unmappedStatuses.length > 0 && <p className="mt-3 text-sm">Unmapped statuses: {q.unmappedStatuses.map((x) => `${x.value} (${x.count})`).join(', ')}</p>}
        {q.unmappedDispositions.length > 0 && <p className="mt-1 text-sm">Unmapped dispositions: {q.unmappedDispositions.map((x) => `${x.value} (${x.count})`).join(', ')}</p>}
        {Object.keys(q.missingValues).length > 0 && <p className="mt-1 text-sm">Blank values: {Object.entries(q.missingValues).map(([k, v]) => `${k} (${v})`).join(', ')}</p>}
        <p className="mt-3 text-xs text-slate-500">Full row-level detail is in the “Data Quality” sheet of the Excel workbook.</p>
      </Section>

      {deliveries.length > 0 && (
        <Section title="Deliveries for this report" className="mt-6">
          <table className="w-full">
            <thead><tr><th className="th">When</th><th className="th">Destination</th><th className="th">Attachments</th><th className="th">Status</th><th className="th">Error</th></tr></thead>
            <tbody>{deliveries.map((l) => <tr key={l._id} className="border-b border-slate-50"><td className="td text-xs">{fmtDateTime(l.createdAt)}</td><td className="td">{l.destinationLabel}</td><td className="td">{l.attachments}</td><td className="td"><StatusBadge status={l.status} /></td><td className="td text-xs text-red-600">{l.error}</td></tr>)}</tbody>
          </table>
        </Section>
      )}
    </>
  );
}
