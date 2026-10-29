import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PlayCircle, Save } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Destination, Schedule } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
interface OneTime { _id: string; sendAt: string; reportDate: string; destinationIds?: string[]; status: string; message?: string; reportId?: string }
interface View { schedule: Schedule; crons: string[]; nextRunAt: string | null; whatsappConfigured: boolean; oneTimeSchedules: OneTime[] }

export default function ScheduleSettings() {
  const { can } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [s, setS] = useState<Schedule | null>(null);
  const [dests, setDests] = useState<Destination[]>([]);
  const [source, setSource] = useState<{ configured: boolean; connected: boolean; database: string | null; message?: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [onceAt, setOnceAt] = useState('');
  const [onceReportDate, setOnceReportDate] = useState('');
  const [onceDestinationIds, setOnceDestinationIds] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    Promise.all([api.get<View>('/settings/schedule'), api.get<{ destinations: Destination[] }>('/whatsapp/destinations'), api.get<NonNullable<typeof source>>('/live/status')])
      .then(([v, d, src]) => {
        const validIds = new Set(d.destinations.filter((destination) => destination.verified).map((destination) => destination._id));
        const preferredGroup = d.destinations.find((destination) => destination.verified && destination.kind === 'group' && /^test controller$/i.test(destination.label));
        const destinationIds = [...new Set(v.schedule.destinationIds || [])].filter((id) => validIds.has(id));
        if (!destinationIds.length && preferredGroup) destinationIds.push(preferredGroup._id);
        const schedule = { ...v.schedule, destinationIds };
        setView({ ...v, schedule }); setS(schedule); setDests(d.destinations); setSource(src);
      })
      .catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
  }, []);
  if (!s || !view) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <Spinner label="Loading…" />;
  const ro = !can('admin');
  const set = (patch: Partial<Schedule>) => setS({ ...s, ...patch });
  const toggleArr = (key: 'days' | 'destinationIds', v: number | string) => {
    const arr = (s[key] as (number | string)[]) || [];
    set({ [key]: arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] } as Partial<Schedule>);
  };

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
    const v = await api.put<View>('/settings/schedule', {
        enabled: s.enabled, times: s.times, timezone: s.timezone, frequency: s.frequency, days: s.days, reportDay: s.reportDay, fixedDate: s.reportDay === 'fixed' ? s.fixedDate : null,
        mode: 'single', fileIds: [], attachments: s.attachments, destinationIds: s.destinationIds,
      });
      setView(v); setS(v.schedule);
      setMsg({ kind: 'success', text: v.schedule.enabled ? `Saved. Next run: ${fmtDateTime(v.nextRunAt)} (runs on the server, no browser needed).` : 'Saved. Automation is disabled.' });
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); }
  };
  const test = async () => {
    if (!confirm('Run the saved schedule now? This fetches the latest calls, builds the report and sends it to the selected WhatsApp recipients.')) return;
    setBusy('test');
    setMsg(null);
    try {
      const r = await api.post<View & { result: { status: string; message: string; reportId?: string } }>('/settings/schedule/test');
      setView(r); setS(r.schedule);
      setMsg({ kind: r.result.status === 'success' ? 'success' : r.result.status === 'generated' ? 'info' : r.result.status === 'partial' ? 'warning' : 'error', text: r.result.message });
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); }
  };
  const scheduleOnce = async () => {
    setBusy('once'); setMsg(null);
    try {
      const v = await api.post<View>('/settings/schedule/once', { sendAt: onceAt, reportDate: onceReportDate, destinationIds: onceDestinationIds });
      setView(v); setMsg({ kind: 'success', text: 'One-time report send scheduled.' });
      setOnceAt(''); setOnceReportDate(''); setOnceDestinationIds([]);
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); }
  };
  const cancelOnce = async (id: string) => {
    try { setView(await api.del<View>(`/settings/schedule/once/${id}`)); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const verified = dests.filter((d) => d.verified);
  const verifiedGroups = verified.filter((d) => d.kind === 'group');

  return (
    <>
      <PageHeader title="Auto Send" subtitle="At the set time the server fetches the calls from MySQL, builds the report and sends it to your selected WhatsApp groups or numbers. No browser needs to be open." />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="label">Next scheduled run</div><div className="font-semibold">{s.enabled ? fmtDateTime(view.nextRunAt) : 'Automation off'}</div><div className="text-xs text-slate-400">Runs at {s.times.join(' and ')} · {s.timezone}</div></div>
        <div className="card p-4"><div className="label">Last execution</div><div className="font-semibold">{fmtDateTime(s.lastRunAt)}</div></div>
        <div className="card p-4"><div className="label">Last status</div><StatusBadge status={s.lastRunStatus} /><div className="mt-1 line-clamp-3 text-xs text-slate-500">{s.lastRunMessage}</div>{s.lastReportId && <Link className="text-xs text-vol underline" to={`/reports/${s.lastReportId}`}>Open report</Link>}</div>
      </div>
      {!view.whatsappConfigured && <div className="mb-4"><Alert kind="warning">WhatsApp is not connected, so scheduled runs will build reports but cannot send them. Connect the session on the WhatsApp Groups page.</Alert></div>}
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}

      <fieldset disabled={ro} className="space-y-6">
        <Section title="1 · When">
          <label className="mb-4 flex items-center gap-3">
            <button type="button" role="switch" aria-checked={s.enabled} onClick={() => set({ enabled: !s.enabled })} className={`relative h-6 w-11 rounded-full transition ${s.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${s.enabled ? 'left-5.5' : 'left-0.5'}`} /></button>
            <span className="font-medium">{s.enabled ? 'Automation enabled' : 'Automation disabled'}</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Report times</label>
              <div className="space-y-2">
                {s.times.map((t, i) => (
                  <div key={i} className="flex gap-2">
                    <input type="time" className="input" value={t} onChange={(e) => set({ times: s.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                    {s.times.length > 1 && <button type="button" className="btn-secondary px-3" onClick={() => set({ times: s.times.filter((_, j) => j !== i) })}>Remove</button>}
                  </div>
                ))}
                {s.times.length < 4 && <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => set({ times: [...s.times, '18:00'] })}>+ Add time</button>}
              </div>
            </div>
            <div><label className="label">Timezone</label><input className="input" value={s.timezone} onChange={(e) => set({ timezone: e.target.value })} /></div>
            <div><label className="label">Frequency</label>
              <select className="input" value={s.frequency} onChange={(e) => set({ frequency: e.target.value as Schedule['frequency'] })}>
                <option value="daily">Every day</option><option value="weekdays">Weekdays (Mon–Fri)</option><option value="custom">Selected days</option>
              </select>
            </div>
          </div>
          {s.frequency === 'custom' && (
            <div className="mt-3 flex flex-wrap gap-2">{DAYS.map((d, i) => <button type="button" key={d} onClick={() => toggleArr('days', i)} className={`btn px-3 py-1.5 ${s.days.includes(i) ? 'bg-accent text-white' : 'border border-slate-300 bg-surface text-slate-600'}`}>{d}</button>)}</div>
          )}
        </Section>

        <Section title="2 · What">
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label">Report day</label>
              <select className="input" value={s.reportDay} onChange={(e) => set({ reportDay: e.target.value as Schedule['reportDay'] })}>
                <option value="today">Today’s report</option><option value="previous">Previous day’s report</option><option value="fixed">A selected date</option>
              </select>
            </div>
            {s.reportDay === 'fixed' && <div><label className="label">Selected report date</label><input type="date" className="input" value={s.fixedDate || ''} onChange={(e) => set({ fixedDate: e.target.value })} /></div>}
            <div><label className="label">Attachments</label>
              <select className="input" value={s.attachments} onChange={(e) => set({ attachments: e.target.value as Schedule['attachments'] })}>
                <option value="both">Image + Excel</option><option value="png">Image only</option><option value="excel">Excel only</option>
              </select>
            </div>
          </div>
          <div className="mt-4">
            {source?.connected
              ? <Alert kind="success">Data source: MySQL <b>{source.database}</b> (connected). Each run pulls that day's answered and missed calls at run time.</Alert>
              : <Alert kind="warning">MySQL is {source?.configured ? 'configured but not reachable' : 'not configured'}. {source?.message} Scheduled runs will fail until it is connected.</Alert>}
          </div>
        </Section>

        <Section title="3 · Send to WhatsApp">
          {verified.length === 0 ? <Alert kind="info">No verified WhatsApp destinations yet. <Link to="/whatsapp" className="underline">Add a group or number</Link> on the WhatsApp Setup page.</Alert> : (
            <div className="flex flex-wrap gap-2">{verified.map((d) => <label key={d._id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"><input type="checkbox" checked={s.destinationIds.includes(d._id)} onChange={() => toggleArr('destinationIds', d._id)} />{d.label} <Badge>{d.kind}</Badge></label>)}</div>
          )}
        </Section>
      </fieldset>

      <Section title="One-time report send">
        <p className="mb-4 text-sm text-slate-500">Choose when to send, the report date, and which WhatsApp groups should receive this report. Attachments use the saved settings. Timezone: {s.timezone}.</p>
        {can('admin') && <div className="mb-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Send date and time</label><input type="datetime-local" className="input" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} /></div>
            <div><label className="label">Report date</label><input type="date" className="input" value={onceReportDate} onChange={(e) => setOnceReportDate(e.target.value)} /></div>
          </div>
          <div><label className="label">Select WhatsApp groups</label>
            {verifiedGroups.length ? <div className="flex flex-wrap gap-2">{verifiedGroups.map((d) => <label key={d._id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${onceDestinationIds.includes(d._id) ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-200'}`}><input type="checkbox" checked={onceDestinationIds.includes(d._id)} onChange={() => setOnceDestinationIds((ids) => ids.includes(d._id) ? ids.filter((id) => id !== d._id) : [...ids, d._id])} />{d.label}</label>)}</div> : <Alert kind="info">No verified WhatsApp groups are available. Add and verify a group in WhatsApp Setup first.</Alert>}
          </div>
          <button className="btn-primary" disabled={!onceAt || !onceReportDate || !onceDestinationIds.length || !!busy} onClick={scheduleOnce}>{busy === 'once' ? 'Scheduling…' : `Schedule one-time send${onceDestinationIds.length ? ` to ${onceDestinationIds.length} group(s)` : ''}`}</button>
        </div>}
        {view.oneTimeSchedules.length > 0 && <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className="th">Send at ({s.timezone})</th><th className="th">Report date</th><th className="th">Groups</th><th className="th">Status</th><th className="th">Result</th><th className="th" /></tr></thead><tbody>{view.oneTimeSchedules.map((x) => <tr key={x._id} className="border-b border-slate-100"><td className="td">{fmtDateTime(x.sendAt)}</td><td className="td">{x.reportDate}</td><td className="td">{(x.destinationIds || []).map((id) => dests.find((d) => d._id === id)?.label || 'Group').join(', ')}</td><td className="td"><StatusBadge status={x.status} /></td><td className="td text-xs">{x.reportId ? <Link className="underline" to={`/reports/${x.reportId}`}>Open report</Link> : x.message}</td><td className="td text-right">{x.status === 'pending' && can('admin') && <button className="btn-danger px-2 py-1 text-xs" onClick={() => void cancelOnce(x._id)}>Cancel</button>}</td></tr>)}</tbody></table></div>}
      </Section>

      {can('admin') ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="btn-primary" onClick={save} disabled={!!busy}><Save className="h-4 w-4" /> {busy === 'save' ? 'Saving…' : 'Save schedule'}</button>
          <button className="btn-secondary" onClick={test} disabled={!!busy}><PlayCircle className="h-4 w-4" /> {busy === 'test' ? 'Running…' : 'Run now (fetch + send)'}</button>
        </div>
      ) : <div className="mt-6"><Alert kind="info">Only admins can change the schedule.</Alert></div>}
    </>
  );
}
