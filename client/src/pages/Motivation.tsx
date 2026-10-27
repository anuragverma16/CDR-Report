import { useEffect, useState } from 'react';
import { PlayCircle, Save, Send, Sparkles } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Destination } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

type Mode = 'predefined' | 'ai' | 'custom';
type MsgType = 'morning' | 'eod';
interface MsgCfg { enabled: boolean; time: string; mode: Mode; text: string; variant: number | null }
interface MotCfg { enabled: boolean; workingDays: number[]; destinationId: string | null; morning: MsgCfg; eod: MsgCfg }
interface MotLog { _id: string; type: 'morning' | 'eod' | 'test'; kind: string; dateKey: string; destinationLabel?: string; text?: string; status: string; attempts: number; error?: string; providerMessageId?: string; scheduledFor?: string; sentAt?: string; createdAt: string }
interface View { config: MotCfg; nextRuns: Record<MsgType, string | null>; history: MotLog[]; aiEnabled: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TITLE: Record<MsgType, string> = { morning: 'Good Morning message', eod: 'Good Evening message' };
/** Number of predefined templates per message type on the server (see motivation.js). */
const TEMPLATE_COUNT = 4;
const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'predefined', label: 'Predefined', hint: 'Built-in messages. A different one is used each day.' },
  { value: 'ai', label: 'AI-generated', hint: 'Fresh wording each time. Needs ANTHROPIC_API_KEY on the server; otherwise a predefined message is sent.' },
  { value: 'custom', label: 'Custom', hint: 'Always sends the text you write below.' },
];

function Card({ label, value }: { label: string; value: string }) {
  return <div className="card p-4"><div className="label">{label}</div><div className="font-semibold">{value}</div></div>;
}

export default function Motivation() {
  const { can } = useAuth();
  const admin = can('admin');
  const [view, setView] = useState<View | null>(null);
  const [cfg, setCfg] = useState<MotCfg | null>(null);
  const [drafts, setDrafts] = useState<Record<MsgType, string>>({ morning: '', eod: '' });
  const [groups, setGroups] = useState<Destination[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info' | 'warning'; text: string } | null>(null);

  const apply = (v: View) => {
    setView(v);
    setCfg(v.config);
    setDrafts({ morning: v.config.morning.mode === 'custom' ? v.config.morning.text : '', eod: v.config.eod.mode === 'custom' ? v.config.eod.text : '' });
  };

  useEffect(() => {
    Promise.all([api.get<View>('/motivation'), api.get<{ destinations: Destination[] }>('/whatsapp/destinations')])
      .then(([v, d]) => { apply(v); setGroups(d.destinations.filter((x) => x.kind === 'group' && x.verified)); })
      .catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
  }, []);

  if (!cfg || !view) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <Spinner label="Loading…" />;

  const set = (patch: Partial<MotCfg>) => setCfg({ ...cfg, ...patch });
  const setMsgCfg = (type: MsgType, patch: Partial<MsgCfg>) => setCfg({ ...cfg, [type]: { ...cfg[type], ...patch } });
  const toggleDay = (d: number) => set({ workingDays: cfg.workingDays.includes(d) ? cfg.workingDays.filter((x) => x !== d) : [...cfg.workingDays, d].sort() });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); }
  };

  const save = () => run('save', async () => {
    const payload = {
      ...cfg,
      morning: { ...cfg.morning, text: cfg.morning.mode === 'custom' ? drafts.morning : '' },
      eod: { ...cfg.eod, text: cfg.eod.mode === 'custom' ? drafts.eod : '' },
    };
    apply(await api.put<View>('/motivation', payload));
    setMsg({ kind: 'success', text: 'Settings saved. Scheduled messages use these settings from now on.' });
  });

  const preview = (type: MsgType) => run(`preview:${type}`, async () => {
    const r = await api.post<{ text: string }>('/motivation/preview', { type, mode: cfg[type].mode, text: drafts[type], variant: cfg[type].variant });
    setDrafts((d) => ({ ...d, [type]: r.text }));
  });

  /** Sends to the real group. The text in the box is sent as shown; an empty box sends the selected mode's text. */
  const send = (type: MsgType | 'test', text: string) => {
    const what = type === 'test' ? 'a test message' : `the ${TITLE[type]}`;
    if (!confirm(`Send ${what} to the WhatsApp group now?`)) return;
    run(`send:${type}`, async () => {
      const r = await api.post<View & { log: MotLog }>('/motivation/send', { type, text: text.trim() || undefined });
      setView(r);
      setMsg(r.log.status === 'accepted'
        ? { kind: 'success', text: 'Sent. WhatsApp accepted the message.' }
        : { kind: 'error', text: r.log.error || 'Not sent. It will be retried automatically if the problem is temporary.' });
    });
  };

  const messageCard = (type: MsgType) => {
    const c = cfg[type];
    const draft = drafts[type];
    return (
      <div className="rounded-xl border border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">{TITLE[type]}</div>
          <div className="text-xs text-slate-500">Next: {view.nextRuns[type] ? fmtDateTime(view.nextRuns[type]) : 'off'}</div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          {MODES.map((m) => (
            <label key={m.value} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${c.mode === m.value ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-slate-200'}`}>
              <input type="radio" name={`mode-${type}`} checked={c.mode === m.value} onChange={() => { setMsgCfg(type, { mode: m.value }); if (m.value !== 'custom') setDrafts((d) => ({ ...d, [type]: '' })); }} />
              {m.label}
            </label>
          ))}
        </div>
        {c.mode === 'predefined' && (
          <div className="mb-2">
            <label className="label">Template</label>
            <select className="input max-w-xs" value={c.variant ?? 'auto'} onChange={(e) => { setMsgCfg(type, { variant: e.target.value === 'auto' ? null : Number(e.target.value) }); setDrafts((d) => ({ ...d, [type]: '' })); }}>
              <option value="auto">Automatic (a different one each day)</option>
              {Array.from({ length: TEMPLATE_COUNT }, (_, i) => <option key={i} value={i}>Template {i + 1}{i === 0 ? ' (approved wording)' : ''}</option>)}
            </select>
          </div>
        )}
        <p className="mb-2 text-xs text-slate-500">{MODES.find((m) => m.value === c.mode)?.hint} Use *text* for bold. The signature is added automatically.</p>
        <textarea
          className="input min-h-[140px] font-sans text-sm"
          value={draft}
          readOnly={c.mode !== 'custom'}
          onChange={(e) => setDrafts((d) => ({ ...d, [type]: e.target.value }))}
          placeholder={c.mode === 'custom' ? 'Write the message the group will receive…' : 'Click Preview to see the message for today.'}
          maxLength={1000}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={!!busy || c.mode === 'custom'} onClick={() => preview(type)}><Sparkles className="h-4 w-4" /> {busy === `preview:${type}` ? 'Generating…' : 'Preview'}</button>
          {admin && <button className="btn-primary" disabled={!!busy} onClick={() => send(type, draft)}><Send className="h-4 w-4" /> {busy === `send:${type}` ? 'Sending…' : 'Send now'}</button>}
          {admin && <button className="btn-secondary" disabled={!!busy || !draft.trim()} onClick={() => send('test', draft)}><PlayCircle className="h-4 w-4" /> Send test</button>}
        </div>
      </div>
    );
  };

  const timeRow = (type: MsgType) => (
    <div className="flex flex-wrap items-center gap-4">
      <button type="button" role="switch" aria-checked={cfg[type].enabled} onClick={() => setMsgCfg(type, { enabled: !cfg[type].enabled })} className={`relative h-6 w-11 rounded-full transition ${cfg[type].enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${cfg[type].enabled ? 'left-5.5' : 'left-0.5'}`} /></button>
      <span className="w-48 font-medium">{TITLE[type]}</span>
      <input type="time" className="input w-36" value={cfg[type].time} onChange={(e) => setMsgCfg(type, { time: e.target.value })} disabled={!cfg[type].enabled} />
      <span className="text-xs text-slate-500">Asia/Kolkata</span>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Team Motivation Messages"
        subtitle="A good-morning greeting and an end-of-day message to the team's WhatsApp group on working days. The server sends them, so the page does not need to stay open."
      />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {!view.aiEnabled && (cfg.morning.mode === 'ai' || cfg.eod.mode === 'ai') && (
        <div className="mb-4"><Alert kind="warning">AI wording is off on the server (ANTHROPIC_API_KEY is not set). Predefined messages are sent instead.</Alert></div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card label="Automation" value={cfg.enabled ? 'On' : 'Off'} />
        <Card label="Next good morning" value={cfg.enabled && cfg.morning.enabled && view.nextRuns.morning ? fmtDateTime(view.nextRuns.morning) : 'Off'} />
        <Card label="Next evening message" value={cfg.enabled && cfg.eod.enabled && view.nextRuns.eod ? fmtDateTime(view.nextRuns.eod) : 'Off'} />
      </div>

      <fieldset disabled={!admin} className="space-y-6">
        <Section title="1 · When and where">
          <label className="mb-4 flex items-center gap-3">
            <button type="button" role="switch" aria-checked={cfg.enabled} onClick={() => set({ enabled: !cfg.enabled })} className={`relative h-6 w-11 rounded-full transition ${cfg.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${cfg.enabled ? 'left-5.5' : 'left-0.5'}`} /></button>
            <span className="font-medium">{cfg.enabled ? 'Automation enabled' : 'Automation disabled'}</span>
          </label>
          <div className="mb-4">
            <label className="label">Group that receives the messages</label>
            <select className="input max-w-md" value={cfg.destinationId || ''} onChange={(e) => set({ destinationId: e.target.value || null })}>
              <option value="">Choose a verified group…</option>
              {groups.map((g) => <option key={g._id} value={g._id}>{g.label}</option>)}
            </select>
            {groups.length === 0 && <p className="mt-1 text-xs text-slate-500">No verified groups yet. Add one on the WhatsApp Setup page.</p>}
          </div>
          <div className="mb-4">
            <label className="label">Working days</label>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d, i) => (
                <button type="button" key={d} onClick={() => toggleDay(i)} className={`btn px-3 py-1.5 ${cfg.workingDays.includes(i) ? 'bg-accent text-white' : 'border border-slate-300 bg-surface text-slate-600'}`}>{d}</button>
              ))}
            </div>
          </div>
          <div className="space-y-3">{timeRow('morning')}{timeRow('eod')}</div>
        </Section>

        <Section title="2 · Messages">
          <div className="grid gap-4 lg:grid-cols-2">
            {messageCard('morning')}
            {messageCard('eod')}
          </div>
          <p className="mt-3 text-xs text-slate-500">Messages never include call counts, individual performance, phone numbers or rankings. Test messages go to the real group and are marked [Test] in the history.</p>
        </Section>
      </fieldset>

      {admin ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="btn-primary" onClick={save} disabled={!!busy}><Save className="h-4 w-4" /> {busy === 'save' ? 'Saving…' : 'Save settings'}</button>
        </div>
      ) : <div className="mt-6"><Alert kind="info">Only admins can change these settings.</Alert></div>}

      <Section title="3 · History" className="mt-8">
        {view.history.length === 0 ? <p className="text-sm text-slate-500">Nothing sent yet.</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-100"><tr><th className="th">Date</th><th className="th">Scheduled for</th><th className="th">Message</th><th className="th">Group</th><th className="th">Status</th><th className="th">Details</th></tr></thead>
              <tbody>
                {view.history.map((h) => (
                  <tr key={h._id} className="border-b border-slate-50">
                    <td className="td whitespace-nowrap text-xs">{fmtDateTime(h.sentAt || h.createdAt)}</td>
                    <td className="td whitespace-nowrap text-xs">{h.scheduledFor ? fmtDateTime(h.scheduledFor) : <span className="text-slate-400">manual</span>}</td>
                    <td className="td text-xs">{h.type === 'test' ? 'Test' : TITLE[h.type]} <span className="text-slate-400">· {h.kind}</span></td>
                    <td className="td text-xs">{h.destinationLabel || '—'}</td>
                    <td className="td"><StatusBadge status={h.status} /></td>
                    <td className="td max-w-xs text-xs text-slate-500">{h.error ? <span className="text-red-600">{h.error}</span> : h.providerMessageId ? `WhatsApp id ${h.providerMessageId}` : h.text?.slice(0, 80)}{h.attempts > 1 && ` · attempt ${h.attempts}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
