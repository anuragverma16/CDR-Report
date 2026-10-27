import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Percent, PhoneCall, PhoneMissed, RefreshCw, RotateCcw, ThumbsDown, ThumbsUp, UploadCloud } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import type { AgentRow, Availability, Summary } from '../lib/types';
import { fmtDuration, num, todayIST } from '../lib/format';
import { Alert, Empty, PageHeader, Section, Spinner } from '../components/ui';
import { ReportTable } from '../components/ReportTable';

interface Dash { empty: boolean; summary?: Summary; total?: AgentRow; agents?: AgentRow[]; availability?: Availability; notes?: string[]; sources?: { name: string; counted: number }[]; duplicatesSkipped?: number }

function Card({ label, value, icon: Icon, tone, hint }: { label: string; value: string; icon: typeof PhoneCall; tone: string; hint?: string }) {
  return (
    <div className="card fade-in p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${tone}`}><Icon className="h-4 w-4" /></span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export default function Overview() {
  const [from, setFrom] = useState(todayIST(-6));
  const [to, setTo] = useState(todayIST());
  const [agentList, setAgentList] = useState<string[]>([]);
  const [agent, setAgent] = useState('');
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ dateFrom: from, dateTo: to, ...(agent && { agents: agent }) });
      const [d, a] = await Promise.all([api.get<Dash>(`/dashboard/summary?${q}`), api.get<{ agents: string[] }>('/dashboard/agents')]);
      setData(d);
      setAgentList(a.agents);
    } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [from, to, agent]);
  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const av = data?.availability;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Live totals from processed CDR records. Duplicates across files are counted once."
        actions={<button className="btn-secondary" onClick={load} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>}
      />
      <div className="card mb-6 grid gap-3 p-4 sm:grid-cols-4">
        <div><label className="label">From</label><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">To</label><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">Agent</label>
          <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">All agents</option>
            {agentList.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}
      {!data && loading && <Spinner label="Loading dashboard…" />}
      {data?.empty && (
        <Empty icon={<UploadCloud className="h-10 w-10" />} title="No processed CDR data yet">
          Upload a Tata Dialer CDR export and process it to see live numbers. <Link className="font-medium text-vol underline" to="/upload">Upload CDR</Link>
        </Empty>
      )}
      {s && av && (
        <>
          {s.totalCalls === 0 && <div className="mb-4"><Alert kind="info">No calls in the selected period{agent ? ` for ${agent}` : ''}.</Alert></div>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card label="Total Calls" value={num(s.totalCalls)} icon={PhoneCall} tone="bg-blue-50 text-vol" />
            <Card label="Answered" value={num(s.answered)} icon={CheckCircle2} tone="bg-green-50 text-dur" />
            <Card label="Missed" value={num(s.missed)} icon={PhoneMissed} tone="bg-rose-50 text-disp" hint={s.unclassified ? `${s.unclassified} with unmapped status` : undefined} />
            <Card label="Answer Rate" value={s.answerRate === null ? 'N/A' : `${s.answerRate}%`} icon={Percent} tone="bg-blue-50 text-ink" hint="Answered ÷ Total Calls" />
            <Card label="Total Talk Time" value={fmtDuration(s.talkSec)} icon={Clock} tone="bg-green-50 text-talk" hint={av.talk === 'partial' ? 'Partial — some calls lack talk time' : av.talk === 'none' ? 'No talk-time column mapped' : undefined} />
            <Card label="Interested" value={num(s.interested)} icon={ThumbsUp} tone="bg-green-50 text-dur" />
            <Card label="Not Interested" value={num(s.notInterested)} icon={ThumbsDown} tone="bg-amber-50 text-amber-700" />
            <Card label="Callbacks" value={num(s.callBack)} icon={RotateCcw} tone="bg-amber-50 text-amber-700" />
          </div>
          {data.agents && data.agents.length > 0 && data.total && (
            <Section title="Agent breakdown" className="mt-6">
              <ReportTable agents={data.agents} total={data.total} availability={av} />
              <div className="mt-3 space-y-1 text-xs text-slate-500">
                {data.notes?.map((n) => <div key={n}>{n}</div>)}
                {!!data.duplicatesSkipped && <div>{data.duplicatesSkipped} duplicate record(s) across files were skipped.</div>}
                {data.sources && <div>Sources: {data.sources.map((x) => `${x.name} (${x.counted})`).join(', ')}</div>}
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}
