import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock3, Database, FileSpreadsheet, Download, ExternalLink, ImageIcon, PhoneIncoming, PhoneMissed, Phone, RefreshCw, Send, Timer, Users, Zap } from 'lucide-react';
import { api, downloadFile, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Report } from '../lib/types';
import { fmtDuration, num, todayIST } from '../lib/format';
import { Alert, Badge, Spinner } from '../components/ui';
import { ReportTable } from '../components/ReportTable';
import { SendPanel } from '../components/SendPanel';

interface SourceTable { kind: 'answered' | 'missed'; name: string; rows: number; latest: string | null; dateColumn: string | null; columns: string[] }
interface LiveStatus { configured: boolean; connected: boolean; host: string | null; database: string | null; tables: SourceTable[]; mapping: Record<string, string> | null; missing: string[]; message?: string }
interface FetchResult {
  report: Report; reportDate: string; fetchedAt: string; reused: boolean;
  fetched: { answered: number; missed: number; noAgent?: number; dbDispositions?: number; filteredInSql: boolean; tables: string[] };
  stats?: { invalid: number; duplicatesInFile: number }; unclassifiedStatuses: { value: string; count: number }[];
  export: { name: string; calls: number; matched: number } | null;
}

const REFRESH = [{ v: 0, l: 'Off' }, { v: 5, l: 'Every 5 min' }, { v: 15, l: 'Every 15 min' }, { v: 30, l: 'Every 30 min' }];
const FIELD_LABEL: Record<string, string> = { agent: 'Agent', callStatus: 'Status', startTime: 'Call time', startDate: 'Call date', callId: 'Call ID', phoneNumber: 'Number', talkTime: 'Talk time', holdTime: 'Ring time', wrapUpTime: 'Total duration', disposition: 'Disposition' };

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function Step({ n, title, state, children }: { n: number; title: string; state: 'done' | 'active' | 'idle'; children?: ReactNode }) {
  const ring = state === 'done' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : state === 'active' ? 'border-accent/50 bg-accent/15 text-accent' : 'border-slate-300 bg-slate-100 text-slate-500';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border text-sm font-bold ${ring}`}>{state === 'done' ? <CheckCircle2 className="h-4.5 w-4.5" /> : n}</div>
      <div className="min-w-0">
        <div className={`text-sm font-semibold ${state === 'idle' ? 'text-slate-500' : 'text-ink'}`}>{title}</div>
        <div className="truncate text-xs text-slate-500">{children}</div>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone: 'blue' | 'green' | 'red' | 'violet' | 'amber' | 'slate' }) {
  const tones = {
    blue: 'from-sky-500/15 text-sky-400', green: 'from-emerald-500/15 text-emerald-400', red: 'from-rose-500/15 text-rose-400',
    violet: 'from-violet-500/15 text-violet-400', amber: 'from-amber-500/15 text-amber-400', slate: 'from-slate-400/10 text-slate-500',
  }[tone];
  return (
    <div className={`card relative overflow-hidden bg-gradient-to-br ${tones.split(' ')[0]} to-transparent p-4`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        <span className={tones.split(' ')[1]}>{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums tracking-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function LiveReport() {
  const { can } = useAuth();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [date, setDate] = useState(todayIST());
  const [refreshMin, setRefreshMin] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<FetchResult | null>(null);
  const [now, setNow] = useState(Date.now());
  const busyRef = useRef(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');

  const loadStatus = useCallback(async () => {
    try { setStatus(await api.get<LiveStatus>('/live/status')); setStatusError(''); } catch (e) { setStatusError(errMsg(e)); }
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // A fetch asked for while one is running (e.g. right after an export upload) runs again once it finishes,
  // so the shown report always reflects everything uploaded before the request.
  const pendingRef = useRef(false);
  const fetchNow = useCallback(async (silent = false) => {
    if (busyRef.current) { pendingRef.current = true; return; }
    busyRef.current = true; setBusy(true); if (!silent) setError('');
    try {
      do {
        pendingRef.current = false;
        const r = await api.post<FetchResult>('/live/fetch', { reportDate: date });
        setResult(r); setError('');
      } while (pendingRef.current);
      loadStatus();
    } catch (e) { setError(errMsg(e)); } finally { busyRef.current = false; pendingRef.current = false; setBusy(false); }
  }, [date, loadStatus]);

  /** The day's Tata Dialer export fills Hold, Wrap Up and Dispositions; fetch again right after so the report uses it. */
  const uploadExport = async (file?: File) => {
    if (!file) return;
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) { setExportError('Upload the Tata Dialer export as .csv or .xlsx.'); return; }
    const fd = new FormData(); fd.append('file', file);
    setExportBusy(true); setExportError('');
    try {
      const r = await api.post<{ file: { dateRange?: { from: string | null; to: string | null } } }>('/live/export', fd);
      const dr = r.file.dateRange;
      if (dr?.from && dr.to && (date < dr.from || date > dr.to)) setExportError(`This export covers ${dr.from === dr.to ? dr.from : `${dr.from} to ${dr.to}`}, not ${date}. Pick that date or upload the export for ${date}.`);
      await fetchNow();
    } catch (e) { setExportError(errMsg(e)); } finally { setExportBusy(false); }
  };

  useEffect(() => {
    if (!refreshMin || !result) return;
    const t = setInterval(() => fetchNow(true), refreshMin * 60000);
    return () => clearInterval(t);
  }, [refreshMin, result, fetchNow]);

  const ready = Boolean(status?.connected && !status.missing.length);
  const rep = result?.report;
  const s = rep?.data.summary;
  const sent = rep && rep.deliveryStatus !== 'not_sent';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent"><Zap className="h-3.5 w-3.5" /> Real-time</div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">Live Report</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Fetch the day's calls straight from the dialer database, check the agent report, then send it to WhatsApp.</p>
        </div>
        <ConnectionPill status={status} error={statusError} onRetry={loadStatus} />
      </div>

      {/* Stepper */}
      <div className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-2">
        <Step n={1} title="Fetch" state={result ? 'done' : ready ? 'active' : 'idle'}>{result ? `${num(result.fetched.answered + result.fetched.missed)} rows pulled` : 'Pull calls from MySQL'}</Step>
        <div className="hidden h-px flex-1 bg-slate-200 sm:block" />
        <Step n={2} title="Report" state={rep ? 'done' : 'idle'}>{rep ? `${s?.agentCount} agents · ${num(s?.totalCalls)} calls` : 'Agent-wise Excel + image'}</Step>
        <div className="hidden h-px flex-1 bg-slate-200 sm:block" />
        <Step n={3} title="Send" state={sent ? 'done' : rep ? 'active' : 'idle'}>{sent ? `Delivery: ${rep?.deliveryStatus}` : 'WhatsApp group / number'}</Step>
      </div>

      {statusError && <Alert kind="error">{statusError}</Alert>}
      {status && !status.configured && <SetupCard />}
      {status?.configured && !status.connected && <Alert kind="error" title="Cannot reach MySQL">{status.message} Check the MYSQL_* settings in server/.env.</Alert>}
      {status?.connected && status.missing.length > 0 && <Alert kind="warning" title="Some columns were not recognized">Missing: {status.missing.join(', ')}. Add the column names to server/.env and restart the server.</Alert>}

      {/* Fetch controls + sources */}
      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card fade-in p-5 lg:col-span-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-44 flex-1">
              <label className="label" htmlFor="live-date">Report date</label>
              <input id="live-date" className="input" type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="flex gap-1.5">
              {[{ l: 'Today', d: todayIST() }, { l: 'Yesterday', d: todayIST(-1) }].map((x) => (
                <button key={x.l} className={`btn border ${date === x.d ? 'border-accent/50 bg-accent/15 text-ink' : 'border-slate-300 bg-raised text-slate-600 hover:text-ink'}`} onClick={() => setDate(x.d)}>{x.l}</button>
              ))}
            </div>
            <div className="min-w-36">
              <label className="label" htmlFor="live-refresh">Auto refresh</label>
              <select id="live-refresh" className="input" value={refreshMin} onChange={(e) => setRefreshMin(Number(e.target.value))} disabled={!result}>
                {REFRESH.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            {can('manager')
              ? <button className="btn-primary px-6 py-3 text-base" disabled={busy || exportBusy || !ready} onClick={() => fetchNow()}>
                  {busy ? <><RefreshCw className="h-5 w-5 animate-spin" /> Fetching live data…</> : <><Database className="h-5 w-5" /> {result ? 'Fetch again' : 'Fetch live report'}</>}
                </button>
              : <Alert kind="info">Only managers and admins can fetch and send reports.</Alert>}
            {result && <span className="flex items-center gap-1.5 text-sm text-slate-500"><Clock3 className="h-4 w-4" /> Last fetched {new Date(result.fetchedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} · {ago(result.fetchedAt, now)}{refreshMin > 0 && <Badge tone="green">auto · {refreshMin}m</Badge>}</span>}
          </div>
          {error && <div className="mt-4"><Alert kind="error">{error}</Alert></div>}
          {result?.reused && !error && <p className="mt-3 text-xs text-slate-500">No new calls since the previous fetch. Showing the same report.</p>}

          {can('manager') && (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink"><FileSpreadsheet className="h-4 w-4 text-accent" /> Tata Dialer export <span className="text-xs font-normal text-slate-500">for Hold, Wrap Up &amp; Dispositions</span></div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {result?.export
                      ? result.export.matched
                        ? <>Using <span className="text-slate-700">{result.export.name}</span>: matched {num(result.export.matched)} of {num(result.fetched.answered + result.fetched.missed)} calls by Call ID.</>
                        : <span className="text-amber-600">{result.export.name} has no Call ID in common with the database calls, so it was not used.</span>
                      : 'Not uploaded for this date. Those columns show N/A until you add it.'}
                  </div>
                </div>
                <label className={`btn-secondary cursor-pointer ${exportBusy || busy ? 'pointer-events-none opacity-50' : ''}`}>
                  {exportBusy ? <><RefreshCw className="h-4 w-4 animate-spin" /> Importing…</> : <><FileSpreadsheet className="h-4 w-4" /> {result?.export ? 'Replace export' : 'Upload export'}</>}
                  <input className="hidden" type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={(e) => { uploadExport(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
              {exportError && <div className="mt-3"><Alert kind="warning">{exportError}</Alert></div>}
            </div>
          )}
        </section>

        <section className="card fade-in p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-ink">Source tables</h2>
            <span className="text-xs text-slate-500">{status?.database}</span>
          </div>
          {!status ? <Spinner label="Checking database…" /> : !status.tables.length ? <p className="text-sm text-slate-500">Not connected.</p> : (
            <div className="space-y-2.5">
              {status.tables.map((t) => (
                <div key={t.name} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3">
                  <div className={`grid h-9 w-9 place-items-center rounded-lg ${t.kind === 'answered' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>{t.kind === 'answered' ? <PhoneIncoming className="h-4.5 w-4.5" /> : <PhoneMissed className="h-4.5 w-4.5" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-ink">{t.name}</div>
                    <div className="truncate text-xs text-slate-500">{t.latest ? `Latest call ${t.latest}` : t.dateColumn ? 'No calls yet' : 'Date filtered after fetch'}</div>
                  </div>
                  <div className="text-right"><div className="font-semibold tabular-nums text-ink">{num(t.rows)}</div><div className="text-[11px] text-slate-500">rows</div></div>
                </div>
              ))}
              {status.mapping && <div className="flex flex-wrap gap-1.5 pt-1">{Object.entries(status.mapping).map(([k, v]) => <span key={k} className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500"><span className="text-slate-600">{FIELD_LABEL[k] || k}</span> → <span className="font-mono">{v}</span></span>)}</div>}
            </div>
          )}
        </section>
      </div>

      {busy && !rep && <div className="card grid place-items-center p-12"><Spinner label="Pulling rows and building the report…" /></div>}

      {rep && s && (
        <div className="fade-in space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Kpi tone="blue" icon={<Phone className="h-4.5 w-4.5" />} label="Total calls" value={num(s.totalCalls)} sub={`${num(result!.fetched.answered + result!.fetched.missed)} rows from ${result!.fetched.tables.join(' + ')}`} />
            <Kpi tone="green" icon={<PhoneIncoming className="h-4.5 w-4.5" />} label="Answered" value={num(s.answered)} sub="Connected calls" />
            <Kpi tone="red" icon={<PhoneMissed className="h-4.5 w-4.5" />} label="Missed" value={num(s.missed)} sub="Not connected" />
            <Kpi tone="violet" icon={<Zap className="h-4.5 w-4.5" />} label="Answer rate" value={s.answerRate === null ? 'N/A' : `${s.answerRate}%`} sub={<RateBar value={s.answerRate} />} />
            <Kpi tone="amber" icon={<Timer className="h-4.5 w-4.5" />} label="Talk time" value={fmtDuration(s.talkSec)} sub="HH:MM:SS" />
            <Kpi tone="slate" icon={<Users className="h-4.5 w-4.5" />} label="Agents" value={s.agentCount} sub={rep.data.quality.allChecksPassed ? <span className="text-emerald-400">All totals reconcile</span> : <span className="text-amber-600">Totals need attention</span>} />
          </div>

          {result!.unclassifiedStatuses.length > 0 && <Alert kind="warning">Some rows are counted in Total but not as Answered or Missed: {result!.unclassifiedStatuses.map((x) => `${x.value} (${x.count})`).join(', ')}.</Alert>}
          <p className="text-xs text-slate-500">Disposition, hold and wrap-up from the database (call_dispositions): {num(result!.fetched.dbDispositions ?? 0)} of {num(result!.fetched.answered + result!.fetched.missed)} calls. Calls without a disposition record are marked * (partial).</p>
          {(result!.fetched.noAgent ?? 0) > 0 && <p className="text-xs text-slate-500">{result!.fetched.noAgent} call(s) with no agent recorded were left out of this report.</p>}
          {result!.stats && result!.stats.invalid > 0 && <Alert kind="warning">{result!.stats.invalid} row(s) could not be read (blank agent or time) and were left out. Details are in the Excel “Data Quality” sheet.</Alert>}

          {/* Agent table */}
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
              <h2 className="font-semibold text-ink">Agent-wise report · {result!.reportDate}</h2>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => downloadFile(`/reports/${rep._id}/excel`, 'report.xlsx').catch((e) => setError(errMsg(e)))}><Download className="h-4 w-4" /> Excel</button>
                {rep.imageStatus === 'ready' && <button className="btn-secondary" onClick={() => downloadFile(`/reports/${rep._id}/image`, 'report.png').catch((e) => setError(errMsg(e)))}><ImageIcon className="h-4 w-4" /> PNG</button>}
                <Link className="btn-secondary" to={`/reports/${rep._id}`}><ExternalLink className="h-4 w-4" /> Details</Link>
              </div>
            </div>
            <div className="p-4"><ReportTable agents={rep.data.agents} total={rep.data.total} availability={rep.data.availability} layout={rep.data.layout} /></div>
            {rep.data.notes.length > 0 && <ul className="space-y-1 border-t border-slate-200 px-5 py-3 text-xs text-slate-500">{rep.data.notes.map((n) => <li key={n}>• {n}</li>)}</ul>}
          </section>

          {/* Preview + send */}
          <div className="grid items-start gap-6 xl:grid-cols-5">
            <section className="card p-5 xl:col-span-3">
              <h2 className="mb-3 font-semibold text-ink">WhatsApp image preview</h2>
              {rep.imageStatus === 'ready'
                ? <a href={`/api/reports/${rep._id}/image?inline=1`} target="_blank" rel="noreferrer"><img key={rep._id} src={`/api/reports/${rep._id}/image?inline=1`} alt={`Agent report for ${result!.reportDate}`} className="w-full rounded-xl border border-slate-200" /></a>
                : <Alert kind="warning" title="Image not available">{rep.imageError || 'The PNG could not be rendered.'} You can still send the Excel file.</Alert>}
            </section>
            <section className="card border-emerald-500/25 p-5 xl:col-span-2">
              <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink"><Send className="h-4 w-4 text-emerald-400" /> Send report</h2>
              <p className="mb-4 text-xs text-slate-500">Sends the image and Excel above to the selected verified groups or numbers.</p>
              {can('manager') ? <SendPanel key={rep._id} report={rep} onSent={() => api.get<{ report: Report }>(`/reports/${rep._id}`).then((r) => setResult((x) => x && { ...x, report: { ...x.report, deliveryStatus: r.report.deliveryStatus } })).catch(() => {})} /> : <Alert kind="info">Only managers and admins can send reports.</Alert>}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function RateBar({ value }: { value: number | null }) {
  return <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-slate-200"><span className="block h-full rounded-full bg-violet-400" style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} /></span>;
}

function ConnectionPill({ status, error, onRetry }: { status: LiveStatus | null; error: string; onRetry: () => void }) {
  const ok = status?.connected;
  const label = !status ? (error ? 'Status unavailable' : 'Checking…') : ok ? 'MySQL connected' : status.configured ? 'MySQL unreachable' : 'MySQL not configured';
  return (
    <button onClick={onRetry} title="Check connection again" className="flex items-center gap-3 rounded-full border border-slate-200 bg-surface py-2 pl-3 pr-4 text-left transition hover:border-slate-300">
      <span className={`h-2.5 w-2.5 rounded-full ${ok ? 'live-dot bg-emerald-400' : status ? 'bg-rose-400' : 'bg-slate-400'}`} />
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {status?.host && <span className="block font-mono text-[11px] text-slate-500">{status.database} @ {status.host}</span>}
      </span>
    </button>
  );
}

function SetupCard() {
  return (
    <section className="card border-accent/30 p-5">
      <h2 className="mb-1 font-semibold text-ink">Connect the dialer database</h2>
      <p className="mb-3 text-sm text-slate-500">Add these lines to <span className="font-mono">server/.env</span> and restart the server. A read-only MySQL user is enough.</p>
      <pre className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-700">{`MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=report_reader
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=nexsahay_dialer
MYSQL_ANSWERED_TABLE=answered_calls
MYSQL_MISSED_TABLE=missed_calls`}</pre>
    </section>
  );
}
