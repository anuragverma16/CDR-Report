import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Send, X } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { Alert, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

interface Group { _id: string; label: string }
interface TeamMessage { _id: string; text: string; destinationLabel?: string; sendAt: string; status: string; error?: string; attempts: number; sentAt?: string }
interface View { groups: Group[]; messages: TeamMessage[]; slots: Record<Slot, string>; timezone: string }

const MAX = 1000;
type Slot = 'morning' | 'evening';
const SLOT_NAMES: Record<Slot, string> = { morning: 'Morning', evening: 'Evening' };
/** Today's date in the browser's own calendar, as yyyy-mm-dd (used as the earliest date to pick). */
const todayText = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function Motivation() {
  const { can } = useAuth();
  const admin = can('admin');
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState<{ destinationId: string; date: string; slot: Slot; text: string }>({ destinationId: '', date: '', slot: 'morning', text: '' });
  const [slotDraft, setSlotDraft] = useState<Record<Slot, string>>({ morning: '09:30', evening: '18:00' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const load = () => api.get<View>('/motivation')
    .then((v) => { setView(v); setSlotDraft(v.slots); setForm((f) => ({ ...f, destinationId: f.destinationId || v.groups[0]?._id || '' })); })
    .catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); }
  };

  const canSubmit = !!form.destinationId && !!form.date && form.text.trim().length > 0 && form.text.length <= MAX;
  const slotText = (s: Slot) => `${SLOT_NAMES[s]} (${view?.slots[s] ?? ''})`;
  const slotsChanged = !!view && (slotDraft.morning !== view.slots.morning || slotDraft.evening !== view.slots.evening);

  const saveSlots = () => run('slots', async () => {
    const v = await api.put<View>('/motivation/slots', slotDraft);
    setView(v);
    setSlotDraft(v.slots);
    setMsg({ kind: 'success', text: `Send times saved: Morning ${v.slots.morning}, Evening ${v.slots.evening}.` });
  });

  const schedule = (e: FormEvent) => {
    e.preventDefault();
    run('schedule', async () => {
      const v = await api.post<View>('/motivation/schedule', { text: form.text, date: form.date, slot: form.slot, destinationId: form.destinationId });
      setView(v);
      setForm((f) => ({ ...f, text: '' }));
      setMsg({ kind: 'success', text: `Scheduled for ${form.date}, ${slotText(form.slot)} (${v.timezone}).` });
    });
  };

  const sendNow = () => {
    if (!confirm('Send this message to the group now?')) return;
    run('now', async () => {
      const r = await api.post<View & { message: TeamMessage | null }>('/motivation/send-now', { text: form.text, destinationId: form.destinationId });
      setView(r);
      if (r.message?.status === 'accepted') {
        setForm((f) => ({ ...f, text: '' }));
        setMsg({ kind: 'success', text: 'Sent. WhatsApp accepted the message.' });
      } else {
        setMsg({ kind: 'error', text: r.message?.error || 'Not sent. It will be retried automatically if the problem is temporary.' });
      }
    });
  };

  const cancel = (m: TeamMessage) => {
    if (!confirm('Cancel this scheduled message?')) return;
    run(`cancel:${m._id}`, async () => { setView(await api.del<View>(`/motivation/messages/${m._id}`)); });
  };

  if (!view) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <Spinner label="Loading…" />;

  return (
    <>
      <PageHeader
        title="Team Messages"
        subtitle={`Write a message, then choose the group, date and time. The server sends it on time (${view.timezone}), even when this page is closed.`}
      />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}

      <fieldset disabled={!admin || !!busy} className="space-y-6">
        <Section title="1 · Send times">
          <div className="grid max-w-md gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Morning</label>
              <input type="time" className="input" value={slotDraft.morning} onChange={(e) => setSlotDraft({ ...slotDraft, morning: e.target.value })} required />
            </div>
            <div>
              <label className="label">Evening</label>
              <input type="time" className="input" value={slotDraft.evening} onChange={(e) => setSlotDraft({ ...slotDraft, evening: e.target.value })} required />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button type="button" className="btn-secondary" disabled={!slotsChanged || !slotDraft.morning || !slotDraft.evening || !!busy} onClick={saveSlots}>
              {busy === 'slots' ? 'Saving…' : 'Save send times'}
            </button>
            <span className="text-xs text-slate-500">{view.timezone}. Messages scheduled for Morning or Evening use these times.</span>
          </div>
        </Section>

        <Section title="2 · New message">
          {view.groups.length === 0 ? (
            <Alert kind="info">No verified WhatsApp group yet. Add one on the WhatsApp Setup page.</Alert>
          ) : (
            <form onSubmit={schedule} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="label">Group</label>
                  <select className="input" value={form.destinationId} onChange={(e) => setForm({ ...form, destinationId: e.target.value })}>
                    {view.groups.map((g) => <option key={g._id} value={g._id}>{g.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Date</label>
                  <input type="date" className="input" min={todayText()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
                </div>
                <div>
                  <label className="label">Time ({view.timezone})</label>
                  <select className="input" value={form.slot} onChange={(e) => setForm({ ...form, slot: e.target.value as Slot })}>
                    {(['morning', 'evening'] as Slot[]).map((s) => <option key={s} value={s}>{slotText(s)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Message</label>
                <textarea
                  className="input min-h-[140px] font-sans text-sm"
                  maxLength={MAX}
                  value={form.text}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  placeholder="Type the message the group will receive…"
                />
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                  <span>Use *text* for bold. The message is sent exactly as typed.</span>
                  <span>{form.text.length}/{MAX}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button className="btn-primary" disabled={!canSubmit || !!busy}>
                  <CalendarClock className="h-4 w-4" /> {busy === 'schedule' ? 'Scheduling…' : 'Schedule message'}
                </button>
                <button type="button" className="btn-secondary" disabled={!form.destinationId || form.text.trim().length === 0 || !!busy} onClick={sendNow}>
                  <Send className="h-4 w-4" /> {busy === 'now' ? 'Sending…' : 'Send now'}
                </button>
              </div>
            </form>
          )}
        </Section>

        <Section title="3 · Scheduled and sent">
          {view.messages.length === 0 ? <p className="text-sm text-slate-500">No messages yet.</p> : (
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-100">
                  <tr><th className="th">Send at</th><th className="th">Group</th><th className="th">Message</th><th className="th">Status</th><th className="th" /></tr>
                </thead>
                <tbody>
                  {view.messages.map((m) => (
                    <tr key={m._id} className="border-b border-slate-50 align-top">
                      <td className="td whitespace-nowrap text-xs">{fmtDateTime(m.sentAt || m.sendAt)}</td>
                      <td className="td text-xs">{m.destinationLabel || '—'}</td>
                      <td className="td max-w-md whitespace-pre-line text-xs">{m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}</td>
                      <td className="td">
                        <StatusBadge status={m.status} />
                        {m.error && <div className="mt-1 max-w-xs text-xs text-red-600">{m.error}</div>}
                        {m.attempts > 1 && <div className="text-xs text-slate-500">attempt {m.attempts}</div>}
                      </td>
                      <td className="td text-right">
                        {(m.status === 'pending' || m.status === 'failed') && admin && (
                          <button className="btn px-2 py-1 text-slate-400 hover:text-red-600" onClick={() => cancel(m)} title="Cancel">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </fieldset>

      {!admin && <div className="mt-4"><Alert kind="info">Only admins can schedule or send messages.</Alert></div>}
    </>
  );
}
