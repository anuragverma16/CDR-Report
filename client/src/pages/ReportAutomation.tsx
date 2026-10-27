import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Database, Download, FileSpreadsheet, ImageIcon, UploadCloud } from 'lucide-react';
import { api, downloadFile, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Report } from '../lib/types';
import { Alert, Badge, PageHeader, Section, Spinner } from '../components/ui';
import { SendPanel } from '../components/SendPanel';

type Preview = { total: number; page: number; pageSize: number; fields?: string[]; headers?: string[]; rows: Record<string, unknown>[]; sheet?: string; sheets?: { name: string; rowCount: number; headers: string[] }[]; filename?: string; size?: number };
type Generated = { report: Report; reportDate: string; dates: string[]; reused: boolean; stats?: { totalRows: number; valid: number; invalid: number; duplicatesInFile: number }; unclassifiedStatuses: { value: string; count: number }[] };

export default function ReportAutomation() {
  const { can } = useAuth();
  const [status, setStatus] = useState<{ connected: boolean; database: string; source: string; maxRows: number }>();
  const [agents, setAgents] = useState<string[]>([]); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [agent, setAgent] = useState(''); const [callStatus, setCallStatus] = useState('');
  const [db, setDb] = useState<Preview>(); const [filePreview, setFilePreview] = useState<Preview>(); const [uploadId, setUploadId] = useState(''); const [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [genDate, setGenDate] = useState(''); const [generated, setGenerated] = useState<Generated | null>(null); const [genError, setGenError] = useState('');

  useEffect(() => { Promise.all([api.get<typeof status>('/report-automation/status'), api.get<{ agents: string[] }>('/report-automation/agents')]).then(([s, a]) => { setStatus(s); setAgents(a.agents); }).catch((e) => setError(errMsg(e))); }, []);
  const query = (page = 1) => new URLSearchParams(Object.entries({ from, to, agent, status: callStatus, page: String(page) }).filter(([, v]) => v));
  const fetchDb = async (page = 1) => { setBusy('database'); setError(''); try { setDb(await api.get<Preview>(`/report-automation/database?${query(page)}`)); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); } };

  const upload = async (file?: File) => {
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { setError('Upload a .xlsx, .xls or .csv file.'); return; }
    const fd = new FormData(); fd.append('file', file); setBusy('upload'); setError(''); setNotice(''); setGenerated(null); setGenError(''); setGenDate('');
    try {
      const r = await api.post<{ upload: { id: string; sheets: { name: string }[] }; warning?: string | null }>('/report-automation/upload', fd);
      setUploadId(r.upload.id); setNotice(r.warning || '');
      const first = r.upload.sheets[0]?.name || ''; setSheet(first); await previewFile(r.upload.id, first);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };
  const previewFile = async (id = uploadId, tab = sheet, page = 1) => { if (!id) return; setBusy('preview'); setError(''); try { setFilePreview(await api.get<Preview>(`/report-automation/upload/${id}/preview?sheet=${encodeURIComponent(tab)}&page=${page}`)); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); } };

  const generate = async (date = genDate) => {
    setBusy('generate'); setGenError('');
    try {
      const r = await api.post<Generated>(`/report-automation/upload/${uploadId}/generate`, date ? { reportDate: date } : {});
      setGenerated(r); setGenDate(r.reportDate);
    } catch (e) { setGenError(errMsg(e)); } finally { setBusy(''); }
  };

  const table = (data?: Preview, paginate?: (p: number) => void) => data && <>
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm"><Badge tone="blue">{data.total.toLocaleString()} records</Badge><span className="text-slate-500">Columns: {(data.headers || data.fields || []).join(', ')}</span></div>
    <div className="max-h-96 overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 bg-slate-100"><tr>{(data.headers || data.fields || []).map((h) => <th className="th whitespace-nowrap" key={h}>{h}</th>)}</tr></thead><tbody>{data.rows.map((row, i) => <tr className="border-b border-slate-50" key={i}>{(data.headers || data.fields || []).map((h) => <td className="td whitespace-nowrap" key={h}>{String(row[h] ?? '')}</td>)}</tr>)}</tbody></table></div>
    {paginate && <div className="mt-3 flex items-center justify-between text-sm"><span>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><div className="flex gap-2"><button className="btn-secondary" disabled={data.page <= 1 || !!busy} onClick={() => paginate(data.page - 1)}>Previous</button><button className="btn-secondary" disabled={data.page * data.pageSize >= data.total || !!busy} onClick={() => paginate(data.page + 1)}>Next</button></div></div>}
  </>;

  const rep = generated?.report;
  const s = rep?.data?.summary;

  return <>
    <PageHeader title="Report Automation" subtitle="Two ways to get the agent report: fetch processed CDR data from the database, or upload the dialer's Excel/CSV export by hand and send the report to WhatsApp." />
    {error && <div className="mb-5"><Alert kind="error">{error}</Alert></div>}
    <div className="mb-6 grid gap-5 lg:grid-cols-2">
      <Section title={<span className="flex items-center gap-2"><Database className="h-4 w-4" /> Fetch from Database <Badge>optional</Badge></span>}>
        <div className="mb-4 flex flex-wrap gap-2"><Badge tone={status?.connected ? 'green' : 'red'}>{status?.connected ? 'Connected' : 'Unavailable'}</Badge><span className="text-sm text-slate-500">{status?.database} · {status?.source}</span></div>
        {status && !status.connected && <div className="mb-4"><Alert kind="info">The database is not reachable. Use the manual upload on the right; it builds and sends the same report.</Alert></div>}
        <div className="grid gap-3 sm:grid-cols-2"><div><label className="label">From</label><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div><div><label className="label">To</label><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div><label className="label">Agent</label><select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All agents</option>{agents.map((x) => <option key={x}>{x}</option>)}</select></div><div><label className="label">Call status</label><input className="input" placeholder="Exact status label" value={callStatus} onChange={(e) => setCallStatus(e.target.value)} /></div>
        </div>
        <button className="btn-primary mt-4" disabled={!!busy || !status?.connected} onClick={() => fetchDb()}>{busy === 'database' ? <Spinner /> : null} Fetch Report</button>
        {db && <div className="mt-5">{table(db, fetchDb)}<button className="btn-secondary mt-4" onClick={() => downloadFile(`/report-automation/database/excel?${query(1)}`, 'Tata_Dialer_CDR_Report.xlsx').catch((e) => setError(errMsg(e)))}>Download Excel</button></div>}
        <p className="mt-4 text-xs text-slate-500">This reads call records that were already uploaded and processed. To build and send a report, use <Link className="underline" to="/reports">Agent Reports</Link>.</p>
      </Section>

      <Section title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> Upload Excel / CSV Report <Badge tone="blue">manual</Badge></span>}>
        <label className="mb-4 flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed border-slate-300 px-5 py-8 text-center hover:border-vol" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); }}><UploadCloud className="mb-2 h-8 w-8 text-vol" /><span className="font-medium">Drop a file here or browse</span><span className="text-xs text-slate-500">.xlsx · .xls · .csv (comma, semicolon, tab or pipe separated)</span><input className="hidden" type="file" accept=".xlsx,.xls,.csv,text/csv" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {busy === 'upload' && <Spinner label="Reading file…" />}
        {notice && <div className="mb-3"><Alert kind="warning">{notice}</Alert></div>}
        {filePreview && <><div className="mb-3 flex flex-wrap items-center gap-3 text-sm"><strong className="break-all">{filePreview.filename}</strong><span className="text-slate-500">{((filePreview.size || 0) / 1024).toFixed(1)} KB</span>{(filePreview.sheets?.length || 0) > 1 && <select className="input max-w-xs" value={sheet} onChange={(e) => { setSheet(e.target.value); previewFile(uploadId, e.target.value); }}>{filePreview.sheets?.map((x) => <option key={x.name}>{x.name}</option>)}</select>}</div>{table(filePreview, (p) => previewFile(uploadId, sheet, p))}<button className="btn-secondary mt-4" onClick={() => downloadFile(`/report-automation/upload/${uploadId}/excel?sheet=${encodeURIComponent(sheet)}`, 'Validated_Report.xlsx').catch((e) => setError(errMsg(e)))}>Download Validated Excel</button></>}
        <p className="mt-4 text-xs text-slate-500">Uploads are kept in private server storage and expire after 30 days.</p>
      </Section>
    </div>

    {uploadId && filePreview && (
      <Section title={<span className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Make agent report &amp; send to WhatsApp</span>} className="mb-6">
        {!can('manager') ? <Alert kind="info">Only managers and admins can build and send reports.</Alert> : <>
          <p className="mb-3 text-sm text-slate-600">Builds the agent-wise report from <b>{filePreview.filename}</b> with the same calculations as Upload CDR: duplicates removed, Answered/Missed from <i>Call Status</i>, dispositions from <i>Disposition Name</i>.{(filePreview.sheets?.length || 0) > 1 && ' For workbooks, the first sheet that has data is used.'}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div><label className="label">Report date</label>
              {generated?.dates?.length
                ? <select className="input" value={genDate} onChange={(e) => setGenDate(e.target.value)}>{generated.dates.map((d) => <option key={d}>{d}</option>)}</select>
                : <input className="input" type="date" value={genDate} onChange={(e) => setGenDate(e.target.value)} />}
              {!generated && <div className="mt-1 text-xs text-slate-400">Leave empty to use the date with the most calls.</div>}
            </div>
            <button className="btn-primary" disabled={!!busy} onClick={() => generate()}>{busy === 'generate' ? <Spinner label="Building report…" /> : <><BarChart3 className="h-4 w-4" /> {generated ? 'Rebuild for this date' : 'Generate agent report'}</>}</button>
          </div>
          {genError && <div className="mt-3"><Alert kind="error">{genError}</Alert></div>}

          {rep && s && <div className="mt-5">
            <div className="mb-3 flex flex-wrap gap-2">
              <Badge tone="blue">{generated!.reportDate}</Badge><Badge tone="blue">{s.agentCount} agents</Badge><Badge tone="blue">{s.totalCalls} calls</Badge>
              <Badge tone="green">{s.answered} answered</Badge><Badge tone="red">{s.missed} missed</Badge>
              {rep.data.quality.allChecksPassed ? <Badge tone="green">All totals check out</Badge> : <Badge tone="amber">Totals need attention</Badge>}
              {generated!.reused && <Badge>file was already imported; reused it</Badge>}
            </div>
            {generated!.unclassifiedStatuses.length > 0 && <div className="mb-3"><Alert kind="warning">These call statuses are not counted as Answered or Missed: {generated!.unclassifiedStatuses.map((x) => `${x.value} (${x.count})`).join(', ')}. Fix them on the Upload CDR page if needed.</Alert></div>}
            {generated!.stats && (generated!.stats.invalid > 0 || generated!.stats.duplicatesInFile > 0) && <p className="mb-3 text-xs text-slate-500">{generated!.stats.invalid} unreadable row(s) and {generated!.stats.duplicatesInFile} duplicate row(s) in the file were left out. Details are in the Excel “Data Quality” sheet.</p>}
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <div>
                {rep.imageStatus === 'ready'
                  ? <a href={`/api/reports/${rep._id}/image?inline=1`} target="_blank" rel="noreferrer"><img src={`/api/reports/${rep._id}/image?inline=1`} alt="Agent report" className="w-full rounded-lg border border-slate-200 shadow-sm" /></a>
                  : <Alert kind="warning" title="Image not available">{rep.imageError || 'The PNG could not be rendered.'} You can still send the Excel file.</Alert>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {rep.imageStatus === 'ready' && <button className="btn-secondary" onClick={() => downloadFile(`/reports/${rep._id}/image`, 'report.png').catch((e) => setGenError(errMsg(e)))}><ImageIcon className="h-4 w-4" /> Download PNG</button>}
                  <button className="btn-secondary" onClick={() => downloadFile(`/reports/${rep._id}/excel`, 'report.xlsx').catch((e) => setGenError(errMsg(e)))}><Download className="h-4 w-4" /> Download Excel</button>
                  <Link className="btn-secondary" to={`/reports/${rep._id}`}>Open full report</Link>
                </div>
              </div>
              <div><div className="label mb-2">Send to WhatsApp group</div><SendPanel key={rep._id} report={rep} /></div>
            </div>
          </div>}
        </>}
      </Section>
    )}
  </>;
}
