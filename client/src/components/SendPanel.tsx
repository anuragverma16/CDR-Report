import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw, Send, Users } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import type { Capabilities, Destination, Report, WhatsAppGroup } from '../lib/types';
import { useAuth } from '../lib/auth';
import { Alert, Spinner, StatusBadge } from './ui';

interface SendResult { destination: string; skipped?: boolean; reason?: string; status?: string; error?: string | null; logId: string }
type Attachments = 'both' | 'excel' | 'png';

const PREFS_KEY = 'sendPanel.prefs';
interface SendPrefs { attachments?: Attachments; destinationIds?: string[] }
/** Last attachment choice and selected chats, kept in this browser so they survive reloads and new reports. */
function readPrefs(): SendPrefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') ?? {}; } catch { return {}; }
}
function writePrefs(prefs: SendPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable: choices just won't persist */ }
}

/** Manual WhatsApp send. Shows the provider's real response; nothing is reported as sent unless WhatsApp accepted it. */
export function SendPanel({ report, onSent }: { report: Report; onSent?: () => void }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [dests, setDests] = useState<Destination[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [attachments, setAttachments] = useState<Attachments>(() => {
    const saved = readPrefs().attachments;
    const imageReady = report.imageStatus === 'ready';
    if (saved && (saved === 'excel' || imageReady)) return saved;
    return imageReady ? 'png' : 'excel';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<SendResult[] | null>(null);
  const { can } = useAuth();
  const [groups, setGroups] = useState<WhatsAppGroup[] | null>(null);
  const [groupBusy, setGroupBusy] = useState('');

  useEffect(() => {
    Promise.all([api.get<{ capabilities: Capabilities }>('/whatsapp/status'), api.get<{ destinations: Destination[] }>('/whatsapp/destinations')])
      .then(([c, d]) => {
        const verifiedIds = d.destinations.filter((x) => x.verified).map((x) => x._id);
        const savedIds = (readPrefs().destinationIds || []).filter((id) => verifiedIds.includes(id));
        const testIds = d.destinations.filter((x) => x.verified && x.kind === 'group' && /^test\s*controller$/i.test(x.label)).map((x) => x._id);
        setCaps(c.capabilities); setDests(d.destinations); setChosen(new Set(testIds.length ? testIds : savedIds)); setReady(true);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  // Only save after the saved selection has been loaded, so the empty initial set never overwrites it.
  useEffect(() => {
    if (ready) writePrefs({ attachments, destinationIds: [...chosen] });
  }, [ready, attachments, chosen]);

  const loadGroups = async () => {
    setGroupBusy('list'); setError('');
    try { setGroups((await api.get<{ groups: WhatsAppGroup[] }>('/whatsapp/groups')).groups || []); } catch (e) { setError(errMsg(e)); } finally { setGroupBusy(''); }
  };
  /** Save a group from the linked WhatsApp number as a destination and tick it for this send. */
  const addGroup = async (g: WhatsAppGroup) => {
    setGroupBusy(g.jid); setError('');
    try {
      const r = await api.post<{ destination: Destination; verification: { instructions: string } }>('/whatsapp/destinations', { label: g.name, kind: 'group', address: g.jid });
      setDests((x) => [...x, r.destination]);
      if (r.destination.verified) setChosen((x) => new Set(x).add(r.destination._id));
      else setError(r.verification.instructions);
    } catch (e) { setError(errMsg(e)); } finally { setGroupBusy(''); }
  };

  const send = async (force = false) => {
    if (force && !confirm('This report was already delivered to these destinations. Send another copy?')) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ results: SendResult[] }>(`/reports/${report._id}/send`, { destinationIds: [...chosen], attachments, force });
      setResults(r.results);
      onSent?.();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  if (!caps) return error ? <Alert kind="error">{error}</Alert> : <Spinner label="Checking WhatsApp setup…" />;
  if (!caps.configured) return <Alert kind="warning" title="WhatsApp is not ready">{caps.connectionError || 'Provider credentials or a connected session are missing.'} Go to <Link className="underline" to="/whatsapp">WhatsApp Groups</Link> to check the connection.</Alert>;
  const verified = dests.filter((d) => d.verified);
  const added = new Set(dests.map((d) => d.address));
  const groupPicker = can('admin') && caps.providerKey === 'nexsahay' && (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Users className="h-4 w-4" /> Groups on {caps.activeSession?.name || 'your WhatsApp'}</span>
        <button className="btn-secondary px-2.5 py-1 text-xs" onClick={loadGroups} disabled={!!groupBusy}><RefreshCw className={`h-3.5 w-3.5 ${groupBusy === 'list' ? 'animate-spin' : ''}`} /> {groups ? 'Refresh' : 'Load groups'}</button>
      </div>
      {groups && (groups.filter((g) => !added.has(g.jid)).length === 0
        ? <p className="text-xs text-slate-500">{groups.length ? 'All groups are already added.' : 'This WhatsApp number is not in any group.'}</p>
        : <div className="max-h-52 space-y-1 overflow-y-auto">{groups.filter((g) => !added.has(g.jid)).map((g) => (
            <div key={g.jid} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100">
              <span className="min-w-0 truncate text-sm">{g.name}</span>
              <button className="btn-secondary shrink-0 px-2 py-1 text-xs" onClick={() => addGroup(g)} disabled={!!groupBusy}>{groupBusy === g.jid ? <Spinner /> : <><Plus className="h-3.5 w-3.5" /> Add</>}</button>
            </div>))}</div>)}
    </div>
  );
  if (!verified.length) return (
    <div className="space-y-3">
      <Alert kind="info">No WhatsApp destinations are ready yet. {can('admin') ? 'Add a group or an individual number in WhatsApp Setup.' : 'Ask an admin to add a group or number.'}</Alert>
      {groupPicker}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
  const canForce = results?.some((r) => r.skipped && (r.status === 'accepted' || r.status === 'delivered'));

  return (
    <div className="space-y-4">
      <div>
        <div className="label">Send to</div>
        <div className="flex flex-wrap gap-2">
          {verified.map((d) => (
            <label key={d._id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${chosen.has(d._id) ? 'border-emerald-500/50 bg-emerald-500/10 text-ink' : 'border-slate-200'}`}>
              <input type="checkbox" checked={chosen.has(d._id)} onChange={(e) => { const n = new Set(chosen); if (e.target.checked) n.add(d._id); else n.delete(d._id); setChosen(n); }} />
              {d.label} <span className="text-xs text-slate-400">{d.kind === 'group' ? 'group' : `+${d.address}`}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="label">Attachments</div>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['both', 'png', 'excel'] as const).map((a) => (
            <label key={a} className="flex items-center gap-2"><input type="radio" name="att" checked={attachments === a} disabled={a !== 'excel' && report.imageStatus !== 'ready'} onChange={() => setAttachments(a)} />{a === 'both' ? 'Image + Excel' : a === 'png' ? 'Image only' : 'Excel only'}</label>
          ))}
        </div>
        {caps.messageMode === 'template' && <p className="mt-1 text-xs text-slate-500">Template mode: image and Excel are sent as two approved template messages ({caps.templates?.image || 'image template not set'}, {caps.templates?.document || 'document template not set'}).</p>}
      </div>
      {groupPicker && <details className="text-sm"><summary className="cursor-pointer text-xs text-slate-500 hover:text-ink">Add another group</summary><div className="mt-2">{groupPicker}</div></details>}
      <button className="btn-green w-full py-3 text-base" disabled={busy || !chosen.size} onClick={() => send(false)}>{busy ? <Spinner label="Sending…" /> : <><Send className="h-4 w-4" /> {`Send to ${chosen.size} ${chosen.size === 1 ? 'chat' : 'chats'} on WhatsApp`}</>}</button>
      {error && <Alert kind="error">{error}</Alert>}
      {results && (
        <div className="space-y-2">
          {results.map((r) => (
            <div key={r.logId + r.destination} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <b>{r.destination}</b>
              {r.skipped ? <span className="text-amber-700">Not sent — {r.reason}</span> : <><StatusBadge status={r.status} />{r.error && <span className="text-red-600">{r.error}</span>}</>}
            </div>
          ))}
          <p className="text-xs text-slate-500">{caps.providerKey === 'nexsahay'
            ? <>“Accepted” means the WhatsApp gateway took the message and returned a message id. Check each recipient’s chat to confirm it arrived. Every attempt is in <Link className="underline" to="/logs">Delivery Logs</Link>.</>
            : <>“Accepted by WhatsApp” means Meta accepted the message. Delivered/read/failed updates arrive via the webhook and show in <Link className="underline" to="/logs">Delivery Logs</Link>.</>}</p>
          {canForce && <button className="btn-secondary" onClick={() => send(true)}>Send another copy anyway</button>}
        </div>
      )}
    </div>
  );
}
