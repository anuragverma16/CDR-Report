import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, FileStack, Layers } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Report, UploadedFile } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Empty, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

export default function AgentReports() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [files, setFiles] = useState<UploadedFile[] | null>(null);
  const [mode, setMode] = useState<'single' | 'combined'>('single');
  const [fileId, setFileId] = useState(params.get('file') || '');
  const [reportDate, setReportDate] = useState(params.get('date') || '');
  const [restrict, setRestrict] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ files: UploadedFile[] }>('/cdr/files').then((r) => {
      setFiles(r.files);
      const processed = r.files.filter((f) => f.status === 'processed');
      if (!fileId && processed[0]) setFileId(processed[0]._id);
      setPicked(new Set(processed.map((f) => f._id)));
      const tos = processed.map((f) => f.dateRange?.to).filter(Boolean) as string[];
      if (tos.length) { const max = tos.sort().at(-1)!; setTo(max); setFrom(max); }
    }).catch((e) => setError(errMsg(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const processed = useMemo(() => (files || []).filter((f) => f.status === 'processed'), [files]);
  const single = processed.find((f) => f._id === fileId);
  useEffect(() => { if (single && !params.get('date')) setReportDate(single.reportDate || single.dateRange?.to || ''); }, [single?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const overlapping = (f: UploadedFile) => !from || !to || !f.dateRange?.from || (f.dateRange.from <= to && (f.dateRange.to || '') >= from);
  const chosen = processed.filter((f) => picked.has(f._id) && overlapping(f));

  const generate = async () => {
    setBusy(true);
    setError('');
    try {
      const r = mode === 'single'
        ? await api.post<{ report: Report }>('/reports/generate', { fileId, reportDate, restrictToDate: restrict })
        : await api.post<{ report: Report }>('/reports/generate-combined', { fileIds: chosen.map((f) => f._id), dateFrom: from, dateTo: to });
      nav(`/reports/${r.report._id}`);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  if (!files) return <Spinner label="Loading files…" />;
  return (
    <>
      <PageHeader title="Agent Reports" subtitle="Generate the agent-wise report, Excel workbook and PNG image from processed CDR data." actions={<Link to="/history" className="btn-secondary">View report history</Link>} />
      {processed.length === 0 ? (
        <Empty icon={<BarChart3 className="h-10 w-10" />} title="No processed CDR files">Upload and process a CDR file first. <Link className="font-medium text-vol underline" to="/upload">Go to Upload CDR</Link></Empty>
      ) : (
        <>
          <div className="mb-6 inline-flex rounded-lg border border-slate-200 bg-surface p-1">
            {([['single', 'Single file report', FileStack], ['combined', 'Combined report', Layers]] as const).map(([m, label, Icon]) => (
              <button key={m} onClick={() => setMode(m)} className={`btn ${mode === m ? 'bg-navy text-white' : 'text-slate-600 hover:bg-slate-50'}`}><Icon className="h-4 w-4" /> {label}</button>
            ))}
          </div>

          {mode === 'single' ? (
            <Section title="Single file report">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2"><label className="label">Processed CDR file</label>
                  <select className="input" value={fileId} onChange={(e) => setFileId(e.target.value)}>
                    {processed.map((f) => <option key={f._id} value={f._id}>{f.originalName} — {f.dateRange?.from === f.dateRange?.to ? f.dateRange?.from : `${f.dateRange?.from} → ${f.dateRange?.to}`} ({f.stats?.valid} records)</option>)}
                  </select>
                </div>
                <div><label className="label">Report date</label><input type="date" className="input" value={reportDate} onChange={(e) => setReportDate(e.target.value)} /></div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} /> Only include calls made on the report date (calls on other dates are listed in Data Quality)</label>
            </Section>
          ) : (
            <Section title="Combined report">
              <div className="mb-4 grid gap-4 sm:grid-cols-2">
                <div><label className="label">From</label><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
                <div><label className="label">To</label><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
              </div>
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full">
                  <thead className="border-y border-slate-100"><tr><th className="th w-10"><input type="checkbox" checked={processed.every((f) => picked.has(f._id))} onChange={(e) => setPicked(new Set(e.target.checked ? processed.map((f) => f._id) : []))} /></th><th className="th">File</th><th className="th">Status</th><th className="th">Dates</th><th className="th">Valid records</th><th className="th">Processed</th></tr></thead>
                  <tbody>
                    {(files || []).map((f) => {
                      const ok = f.status === 'processed';
                      const inRange = overlapping(f);
                      return (
                        <tr key={f._id} className={`border-b border-slate-50 ${!ok || !inRange ? 'opacity-50' : ''}`}>
                          <td className="td"><input type="checkbox" disabled={!ok} checked={ok && picked.has(f._id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(f._id); else n.delete(f._id); setPicked(n); }} /></td>
                          <td className="td font-medium">{f.originalName}{ok && !inRange && <div className="text-xs text-slate-400">No data in selected period</div>}</td>
                          <td className="td"><StatusBadge status={f.status} /></td>
                          <td className="td whitespace-nowrap">{f.dateRange?.from ? `${f.dateRange.from} → ${f.dateRange.to}` : '—'}</td>
                          <td className="td tabular-nums">{f.stats?.valid ?? '—'}</td>
                          <td className="td text-xs">{fmtDateTime(f.processedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-slate-600"><b>{chosen.length}</b> file(s) included · up to <b>{chosen.reduce((s, f) => s + (f.stats?.valid || 0) + (f.stats?.duplicatesOfImported || 0), 0)}</b> records before cross-file de-duplication. Records with the same Call ID (or same agent/time/number) are counted once; the audit trail lists every file.</p>
            </Section>
          )}
          {error && <div className="mt-4"><Alert kind="error">{error}</Alert></div>}
          {can('manager') ? (
            <div className="mt-4"><button className="btn-primary" disabled={busy || (mode === 'single' ? !fileId || !reportDate : !chosen.length || !from || !to)} onClick={generate}>{busy ? <Spinner label="Generating report, Excel and PNG…" /> : <><BarChart3 className="h-4 w-4" /> Generate report</>}</button></div>
          ) : <div className="mt-4"><Alert kind="info">Your role can view reports but not generate them.</Alert></div>}
        </>
      )}
    </>
  );
}
