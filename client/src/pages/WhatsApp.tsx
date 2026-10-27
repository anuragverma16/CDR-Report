import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, MessageCircle, Plus, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2, Users, XCircle } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Capabilities, Destination, GatewaySession, WhatsAppGroup } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, PageHeader, Section, Spinner } from '../components/ui';

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-dur" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
      <div><span className="font-medium">{label}</span>{hint && <div className="text-xs text-slate-500">{hint}</div>}</div>
    </div>
  );
}

function SessionStatus({ status }: { status: string }) {
  const s = status.toUpperCase();
  const tone = s === 'CONNECTED' ? 'green' : s === 'QR_READY' ? 'amber' : 'red';
  return <Badge tone={tone}>{s === 'QR_READY' ? 'waiting for QR scan' : s.toLowerCase()}</Badge>;
}

/** Live QR for a pairing session; polls until the phone links (status CONNECTED). */
function QrPanel({ session, onConnected, onClose }: { session: GatewaySession; onConnected: () => void; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState(session.status);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get<{ session: { status: string; qr: string | null } }>(`/whatsapp/sessions/${session.id}`);
        if (stop) return;
        setStatus(r.session.status);
        setQr(r.session.qr);
        setError('');
        if (r.session.status.toUpperCase() === 'CONNECTED') { onConnected(); return; }
      } catch (e) { if (!stop) setError(errMsg(e)); }
      if (!stop) setTimeout(tick, 4000);
    };
    tick();
    return () => { stop = true; };
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-amber-900">Link “{session.name}” to WhatsApp</div>
        <button className="text-xs text-amber-900 underline" onClick={onClose}>Close</button>
      </div>
      <ol className="mb-3 list-decimal pl-5 text-xs text-amber-900">
        <li>Open WhatsApp on the phone whose number should send the reports.</li>
        <li>Go to <b>Settings → Linked devices → Link a device</b>.</li>
        <li>Scan this code. This panel updates by itself when the phone is linked.</li>
      </ol>
      {error && <Alert kind="error">{error}</Alert>}
      {qr ? <img src={qr} alt="WhatsApp pairing QR code" className="mx-auto h-56 w-56 rounded bg-surface p-2" />
        : <div className="py-6 text-center text-xs text-amber-900">{status.toUpperCase() === 'QR_READY' ? <Spinner label="Loading QR code…" /> : `Session status: ${status}. No QR code is available. If it stays this way, restart the session in the Nexsahay console.`}</div>}
      <div className="mt-2 text-center text-xs text-amber-900">Status: <b>{status}</b> · refreshes every 4 seconds</div>
    </div>
  );
}

export default function WhatsApp() {
  const { can } = useAuth();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [dests, setDests] = useState<Destination[]>([]);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [groupsError, setGroupsError] = useState('');
  const [form, setForm] = useState({ label: '', kind: 'group' as 'individual' | 'group', address: '' });
  const [verification, setVerification] = useState<{ label: string; code?: string; instructions: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [qrFor, setQrFor] = useState<GatewaySession | null>(null);

  const loadGroups = useCallback(async () => {
    setGroupsError('');
    try { setGroups((await api.get<{ groups: WhatsAppGroup[] }>('/whatsapp/groups')).groups || []); } catch (e) { setGroups([]); setGroupsError(errMsg(e)); }
  }, []);
  const load = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([
        api.get<{ capabilities: Capabilities }>('/whatsapp/status'),
        api.get<{ destinations: Destination[] }>('/whatsapp/destinations'),
      ]);
      setCaps(c.capabilities);
      setDests(d.destinations);
      if (c.capabilities.activeSession) loadGroups();
    } catch (e) { setError(errMsg(e)); }
  }, [loadGroups]);

  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  const selectSession = (id: string | null) => run(`select:${id}`, async () => {
    const r = await api.put<{ capabilities: Capabilities }>('/whatsapp/session', { sessionId: id });
    setCaps(r.capabilities);
    if (r.capabilities.activeSession) loadGroups(); else setGroups([]);
  });

  const addGroupDestination = (g: WhatsAppGroup) => run(`add:${g.jid}`, async () => {
    const r = await api.post<{ destination: Destination; verification: { code?: string; instructions: string } }>('/whatsapp/destinations', { label: g.name, kind: 'group', address: g.jid });
    setVerification({ label: r.destination.label, ...r.verification });
    await load();
  });

  const add = (e: FormEvent) => { e.preventDefault(); run('add', async () => {
    const r = await api.post<{ destination: Destination; verification: { code?: string; instructions: string } }>('/whatsapp/destinations', form);
    setVerification({ label: r.destination.label, ...r.verification });
    setForm({ label: '', kind: 'group', address: '' });
    await load();
  }); };

  const regenerate = (d: Destination) => run(`regen:${d._id}`, async () => {
    const r = await api.post<{ verification: { code: string; instructions: string } }>(`/whatsapp/destinations/${d._id}/regenerate-code`);
    setVerification({ label: d.label, ...r.verification });
  });
  const verifyGroup = (d: Destination) => run(`verify:${d._id}`, async () => { await api.post(`/whatsapp/destinations/${d._id}/verify-group`); await load(); });
  const remove = (d: Destination) => { if (confirm(`Remove ${d.label}? Scheduled sends to it will stop.`)) run(`del:${d._id}`, async () => { await api.del(`/whatsapp/destinations/${d._id}`); await load(); }); };

  if (!caps) return error ? <Alert kind="error">{error}</Alert> : <Spinner label="Loading…" />;
  const isNexsahay = caps.providerKey === 'nexsahay';
  const sessions = caps.sessions || [];
  const connected = !!caps.activeSession;

  return (
    <>
      <PageHeader
        title="WhatsApp Setup"
        subtitle="Connect a WhatsApp session and choose the groups or people that receive reports."
        actions={<button className="btn-secondary" onClick={() => run('reload', load)} disabled={!!busy}><RefreshCw className={`h-4 w-4 ${busy === 'reload' ? 'animate-spin' : ''}`} /> Refresh</button>}
      />
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}
      {caps.connectionError && <div className="mb-4"><Alert kind="warning" title="Reports cannot be sent yet">{caps.connectionError}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {isNexsahay ? (
          <Section title="WhatsApp sessions" actions={<a href={caps.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-vol underline">API docs <ExternalLink className="h-3 w-3" /></a>}>
            <Check ok={sessions.length > 0} label={sessions.length ? `Gateway reachable · ${sessions.length} session(s)` : 'No sessions found on the gateway'} hint={sessions.length ? undefined : 'Create a session in the Nexsahay console first.'} />
            <Check ok={connected} label={connected ? `Sending from: ${caps.activeSession!.name}` : 'No connected session — reports cannot be sent'} hint={connected ? `Session ${caps.activeSession!.id} · key: ${caps.keySource === 'session' ? "session's own API key" : caps.keySource === 'env' ? 'NEXSAHAY_API_KEY from .env' : 'none'}` : 'Pick a session below and scan its QR code with your phone.'} />
            {sessions.length > 0 && (
              <div className="mt-3 space-y-2">
                {sessions.map((s) => {
                  const selected = caps.selectedSessionId === s.id;
                  return (
                    <div key={s.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 text-sm ${selected ? 'border-navy bg-blue-50/40' : 'border-slate-200 bg-surface'}`}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-slate-400" />{s.name}{selected && <Badge tone="blue">selected</Badge>}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500"><SessionStatus status={s.status} /><span className="font-mono">{s.id}</span></div>
                      </div>
                      {can('admin') && (
                        <div className="flex shrink-0 gap-1">
                          {s.status.toUpperCase() !== 'CONNECTED' && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setQrFor(s)}><QrCode className="mr-1 h-3.5 w-3.5" /> Show QR</button>}
                          {!selected && <button className="btn-secondary px-2 py-1 text-xs" disabled={!!busy} onClick={() => selectSession(s.id)}>Use this</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {can('admin') && caps.selectedSessionId && <button className="text-xs text-slate-500 underline" onClick={() => selectSession(null)}>Clear selection (use NEXSAHAY_SESSION_ID from .env, or the first connected session)</button>}
              </div>
            )}
            {qrFor && <QrPanel key={qrFor.id} session={qrFor} onClose={() => setQrFor(null)} onConnected={() => { setQrFor(null); load(); }} />}
          </Section>
        ) : (
          <Section title="Provider setup">
            <Check ok={caps.configured} label="Phone number ID & access token" hint="WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN" />
            <Check ok={caps.webhookConfigured} label="Webhook" hint="WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN" />
            <Check ok={caps.messageMode !== 'template' || !!(caps.templates?.image && caps.templates?.document)} label={`Message mode: ${caps.messageMode}`} />
            <Check ok={!!caps.businessNumber} label={`Business number: ${caps.businessNumber || 'not set'}`} />
            <p className="mt-2 text-xs text-slate-500">{caps.limits.groups}</p>
          </Section>
        )}

        <Section title="Groups on this WhatsApp number" actions={<button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => run('groups', loadGroups)} disabled={!!busy || !connected}><RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy === 'groups' ? 'animate-spin' : ''}`} /> Refresh groups</button>}>
          {!connected ? <p className="text-sm text-slate-500">Groups appear here once a session is connected.</p>
            : groupsError ? <Alert kind="error">{groupsError}</Alert>
            : groups.length === 0 ? <p className="text-xs text-slate-500">The gateway returned no groups for this session. It only knows groups the linked number has seen; send a message in the group from the phone, then refresh. You can also type the group JID below.</p>
            : (
              <div className="max-h-96 space-y-2 overflow-y-auto">
                {groups.map((g) => {
                  const added = dests.some((d) => d.address === g.jid);
                  return (
                    <div key={g.jid} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-surface p-2.5 text-xs">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium text-slate-800"><Users className="h-3.5 w-3.5 text-dur" /><span className="truncate">{g.name}</span></div>
                        <div className="truncate font-mono text-[11px] text-slate-400">{g.jid}</div>
                      </div>
                      {added ? <Badge tone="green">Added</Badge> : can('admin') && <button className="btn-secondary shrink-0 px-2 py-1 text-xs" disabled={!!busy} onClick={() => addGroupDestination(g)}><Plus className="mr-1 h-3 w-3" /> Add destination</button>}
                    </div>
                  );
                })}
              </div>
            )}
        </Section>
      </div>

      <Section title="Configured destinations" className="mt-6">
        {verification && (
          <div className="mb-4"><Alert kind="info" title={`Destination “${verification.label}”`}>
            {verification.code && <div className="my-1 text-lg font-bold tracking-widest">VERIFY {verification.code}</div>}
            {verification.instructions} <button className="ml-2 underline" onClick={() => { setVerification(null); load(); }}>Done — refresh</button>
          </Alert></div>
        )}
        {dests.length === 0 ? <p className="text-sm text-slate-500">No destinations yet. Add a group from the list above, or add a group or person below.</p> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-100"><tr><th className="th">Name</th><th className="th">Type</th><th className="th">Address / JID</th><th className="th">Status</th><th className="th">Verified at</th><th className="th" /></tr></thead>
              <tbody>
                {dests.map((d) => (
                  <tr key={d._id} className="border-b border-slate-50">
                    <td className="td font-medium">{d.label}</td>
                    <td className="td"><Badge tone={d.kind === 'group' ? 'green' : 'blue'}>{d.kind}</Badge></td>
                    <td className="td font-mono text-xs">{d.kind === 'individual' ? (d.address.includes('@') ? d.address : `+${d.address}`) : d.address}</td>
                    <td className="td">{d.verified ? <Badge tone="green"><ShieldCheck className="mr-1 h-3 w-3" />ready</Badge> : <Badge tone="amber">not confirmed</Badge>}</td>
                    <td className="td text-xs">{d.verifiedAt ? fmtDateTime(d.verifiedAt) : '—'}</td>
                    <td className="td whitespace-nowrap text-right">
                      {can('admin') && !d.verified && d.kind === 'individual' && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => regenerate(d)}>New code</button>}
                      {can('admin') && !d.verified && d.kind === 'group' && <button className="btn-secondary px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => verifyGroup(d)}>Verify</button>}
                      {can('admin') && <button className="btn ml-1 px-2 py-1 text-slate-400 hover:text-red-600" onClick={() => remove(d)} title="Remove"><Trash2 className="h-4 w-4" /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can('admin') && (
          <form onSubmit={add} className="mt-5 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-4">
            <div><label className="label">Name</label><input className="input" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={form.kind === 'group' ? 'e.g. Sales Team' : 'e.g. Anurag Verma'} /></div>
            <div><label className="label">Send to</label>
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'individual' | 'group', address: '' })}>
                <option value="group">WhatsApp group</option>
                <option value="individual">Individual number</option>
              </select>
            </div>
            <div>
              <label className="label">{form.kind === 'group' ? 'Group JID' : 'Mobile number with country code'}</label>
              <input className="input font-mono" required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={form.kind === 'group' ? '120363350828890110@g.us' : '919812345678'} />
            </div>
            <div className="flex items-end"><button className="btn-primary w-full" disabled={!!busy}><Plus className="h-4 w-4" /> Add destination</button></div>
          </form>
        )}
      </Section>

      <p className="mt-4 flex items-center gap-1 text-xs text-slate-400"><MessageCircle className="h-3.5 w-3.5" /> Setup changes apply to future report sends.</p>
    </>
  );
}
