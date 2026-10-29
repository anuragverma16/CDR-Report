import { useEffect, useState, type FormEvent } from 'react';
import { Cake, ImagePlus, Pencil, Send, Trash2, Users, X } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

interface Employee { _id: string; name: string; dob: string; imageUrl: string; imagePublicId?: string }
interface Group { _id: string; label: string }
interface SendLog { _id: string; employeeName: string; destinationLabel: string; dateKey: string; status: string; error?: string; message: string; createdAt: string }
interface BirthdaySchedule { _id: string; employeeName: string; destinationLabel: string; sendAt: string; status: string; error?: string }
interface View { employees: Employee[]; groups: Group[]; sends: SendLog[]; schedules: BirthdaySchedule[]; timezone: string; cloudinaryConfigured: boolean; settings: { enabled: boolean; destinationId?: string; time: string; message: string } }

export default function Employees() {
  const { can } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [name, setName] = useState(''); const [dob, setDob] = useState('');
  const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState('');
  const [groupId, setGroupId] = useState(''); const [enabled, setEnabled] = useState(false); const [message, setMessage] = useState('🎂 *Happy Birthday, {name}!*\n\nWishing you a wonderful day filled with happiness, laughter, and the people you love. Your dedication, positivity, and contribution mean so much to our team, and we’re grateful to have you with us.\n\nMay the year ahead bring you good health, new opportunities, success, and many moments to celebrate. Enjoy your special day—you deserve it! 🎉🥳'); const [previewEmployeeId, setPreviewEmployeeId] = useState('');
  const [scheduledEmployee, setScheduledEmployee] = useState(''); const [scheduledDate, setScheduledDate] = useState(''); const [scheduledTime, setScheduledTime] = useState('00:00');
  const [editingId, setEditingId] = useState(''); const [editName, setEditName] = useState(''); const [editDob, setEditDob] = useState(''); const [editFile, setEditFile] = useState<File | null>(null); const [editPreview, setEditPreview] = useState('');
  const [busy, setBusy] = useState(''); const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const load = () => api.get<View>('/employees').then((v) => { setView(v); setEnabled(v.settings.enabled); setGroupId(v.settings.destinationId || v.groups.find((g) => /^test controller$/i.test(g.label))?._id || v.groups[0]?._id || ''); setMessage(v.settings.message); setPreviewEmployeeId((id) => id || v.employees[0]?._id || ''); }).catch((e) => setNotice({ kind: 'error', text: errMsg(e) }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); setNotice(null); try { await fn(); } catch (e) { setNotice({ kind: 'error', text: errMsg(e) }); } finally { setBusy(''); } };
  const chooseFile = (f?: File) => { if (!f) return; if (!f.type.startsWith('image/')) { setNotice({ kind: 'error', text: 'Choose an image file.' }); return; } setFile(f); setPreview(URL.createObjectURL(f)); };
  const create = (e: FormEvent) => { e.preventDefault(); void run('create', async () => {
    if (!file) throw new Error('Choose an employee image first.');
    const form = new FormData(); form.set('file', file);
    const uploaded = await api.post<{ imageUrl: string; imagePublicId: string }>('/employees/photo', form);
    await api.post('/employees', { name, dob, ...uploaded });
    setName(''); setDob(''); setFile(null); setPreview(''); await load(); setNotice({ kind: 'success', text: 'Employee profile created.' });
  }); };
  const saveSettings = () => void run('settings', async () => { const v = await api.put<View>('/employees/birthday-settings', { enabled, destinationId: groupId || null, time: '00:00', message }); setView(v); setNotice({ kind: 'success', text: `Birthday automation will send at 12:00 AM (${v.timezone}).` }); });
  const scheduleOne = () => void run('schedule', async () => { const v = await api.post<View>('/employees/schedules', { employeeId: scheduledEmployee, destinationId: groupId, date: scheduledDate, time: scheduledTime, message }); setView(v); setNotice({ kind: 'success', text: `Birthday image scheduled for ${scheduledDate} at ${scheduledTime} (${v.timezone}).` }); });
  const cancelOne = (s: BirthdaySchedule) => { if (!confirm(`Cancel the scheduled birthday message for ${s.employeeName}?`)) return; void run(`cancel:${s._id}`, async () => { setView(await api.del<View>(`/employees/schedules/${s._id}`)); }); };
  const send = (employee: Employee) => { if (!groupId) { setNotice({ kind: 'error', text: 'Add a verified WhatsApp group in WhatsApp Setup first.' }); return; } if (!confirm(`Send a birthday image for ${employee.name} to the selected WhatsApp group now?`)) return; void run(`send:${employee._id}`, async () => { const r = await api.post<{ result: { status: string; error?: string; message?: string } }>(`/employees/${employee._id}/send-birthday`, { destinationId: groupId, message }); await load(); if (r.result.status === 'accepted') setNotice({ kind: 'success', text: `Birthday image accepted by WhatsApp for ${employee.name}.` }); else setNotice({ kind: 'error', text: r.result.error || r.result.message || 'Message was not sent.' }); }); };
  const startEdit = (employee: Employee) => { setEditingId(employee._id); setEditName(employee.name); setEditDob(employee.dob); setEditFile(null); setEditPreview(''); };
  const saveEdit = (event: FormEvent, employee: Employee) => { event.preventDefault(); void run(`edit:${employee._id}`, async () => {
    let imageUrl = employee.imageUrl; let imagePublicId = employee.imagePublicId;
    if (editFile) { const form = new FormData(); form.set('file', editFile); const uploaded = await api.post<{ imageUrl: string; imagePublicId: string }>('/employees/photo', form); imageUrl = uploaded.imageUrl; imagePublicId = uploaded.imagePublicId; }
    await api.put(`/employees/${employee._id}`, { name: editName, dob: editDob, imageUrl, imagePublicId });
    setEditingId(''); setEditFile(null); setEditPreview(''); await load(); setNotice({ kind: 'success', text: 'Employee profile updated.' });
  }); };
  const remove = (employee: Employee) => { if (!confirm(`Delete ${employee.name}'s employee profile?`)) return; void run(`delete:${employee._id}`, async () => { await api.del(`/employees/${employee._id}`); await load(); }); };
  if (!view) return notice ? <Alert kind={notice.kind}>{notice.text}</Alert> : <Spinner label="Loading employees…" />;
  const admin = can('admin'); const manager = can('manager');
  const selectedEmployee = view.employees.find((employee) => employee._id === previewEmployeeId) || view.employees[0];
  const previewName = selectedEmployee?.name || name || 'Employee';
  const previewImage = selectedEmployee?.imageUrl || preview;
  const previewGroup = view.groups.find((group) => group._id === groupId)?.label || 'Test Controller';
  const previewMessage = message.replaceAll('{name}', previewName);
  const previewMessageParts = previewMessage.split(/(\*[^*]+\*)/g).filter(Boolean);
  return <>
    <PageHeader title="Employee Birthdays" subtitle="Keep employee profiles together and send their birthday photo with a greeting to a verified WhatsApp group." />
    {notice && <div className="mb-4"><Alert kind={notice.kind}>{notice.text}</Alert></div>}
    {!view.cloudinaryConfigured && <div className="mb-5"><Alert kind="warning" title="Cloudinary needs server setup">Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in the server environment before uploading employee photos.</Alert></div>}
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Section title={<span className="flex items-center gap-2"><Users className="h-4 w-4" /> Add employee profile</span>}>
        <form onSubmit={create} className="space-y-4">
          <div><label className="label">Full name</label><input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} required placeholder="Employee name" /></div>
          <div><label className="label">Date of birth</label><input type="date" className="input" value={dob} onChange={(e) => setDob(e.target.value)} required /></div>
          <div><label className="label">Photo</label><label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 p-3 hover:border-accent"><span className="grid h-12 w-12 place-items-center overflow-hidden rounded-md bg-slate-100">{preview ? <img src={preview} className="h-full w-full object-contain" /> : <ImagePlus className="h-5 w-5 text-slate-500" />}</span><span className="text-sm text-slate-600">{file?.name || 'Choose an image (up to 8 MB)'}</span><input type="file" accept="image/*" className="sr-only" onChange={(e) => chooseFile(e.target.files?.[0])} /></label></div>
          <button className="btn-primary w-full" disabled={!manager || !view.cloudinaryConfigured || !!busy}>{busy === 'create' ? 'Saving profile…' : 'Create employee profile'}</button>
          {!manager && <p className="text-xs text-slate-500">Manager access is needed to manage employees.</p>}
        </form>
      </Section>
      <Section title={<span className="flex items-center gap-2"><Cake className="h-4 w-4" /> Birthday automation</span>}>
        <div className="space-y-4">
          <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!admin} /> Automatically send birthday images each year</label>
          <div className="grid gap-4 sm:grid-cols-2"><div><label className="label">Verified WhatsApp group</label><select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={!admin || !view.groups.length}><option value="">Select a group</option>{view.groups.map((g) => <option key={g._id} value={g._id}>{g.label}</option>)}</select></div><div><label className="label">Automatic send time</label><div className="input bg-slate-100 text-slate-600">12:00 AM · {view.timezone}</div></div></div>
          <div><label className="label">Birthday greeting</label><textarea className="input min-h-24" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!admin} /><p className="mt-1 text-xs text-slate-500">Use {'{name}'} to insert the employee's name. The greeting is the image caption.</p></div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-semibold text-ink">WhatsApp message preview</div>{view.employees.length > 0 && <select className="input max-w-56 py-1.5" value={selectedEmployee?._id || ''} onChange={(e) => setPreviewEmployeeId(e.target.value)} aria-label="Preview employee"><option value="">Choose employee</option>{view.employees.map((employee) => <option key={employee._id} value={employee._id}>{employee.name}</option>)}</select>}</div>
            <div className="max-w-sm space-y-2">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-3 py-2 text-[11px] font-medium text-emerald-700">Image message · {previewGroup}</div>{previewImage ? <img src={previewImage} alt={`${previewName} birthday image`} className="block h-auto w-full bg-white" /> : <div className="grid h-40 place-items-center bg-slate-100 text-sm text-slate-600">Employee photo appears here</div>}</div>
              <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className="mb-1 text-[11px] font-medium text-emerald-700">Text message · sent below the image</div><p className="whitespace-pre-wrap text-sm" style={{ color: '#111827' }}>{previewMessageParts.map((part, index) => part.startsWith('*') && part.endsWith('*') ? <strong key={index}>{part.slice(1, -1)}</strong> : part)}</p></div>
            </div>
            <p className="mt-2 text-xs text-slate-500">At 12:00 AM ({view.timezone}), {previewGroup} receives the full photo first, followed by this separate text message.</p>
          </div>
          <button className="btn-secondary" disabled={!admin || !!busy} onClick={saveSettings}>{busy === 'settings' ? 'Saving…' : 'Save automation'}</button>
          {!view.groups.length && <p className="text-xs text-amber-700">No verified groups yet. Add one in WhatsApp Setup.</p>}
        </div>
      </Section>
    </div>
    <div className="mt-5"><Section title={`Employees (${view.employees.length})`}>
      {!view.employees.length ? <p className="text-sm text-slate-500">No employee profiles yet.</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{view.employees.map((emp) => <article key={emp._id} className="rounded-xl border border-slate-200 p-3">
        <div className="flex items-center gap-3"><img src={emp.imageUrl} alt={`${emp.name}'s profile`} className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-slate-100 object-contain object-center" /><div className="min-w-0 flex-1"><div className="truncate font-semibold text-ink">{emp.name}</div><div className="text-xs text-slate-500">Date of birth · {emp.dob}</div><div className="mt-1 text-xs text-slate-500">{enabled && groupId ? `Auto birthday image · 12:00 AM (${view.timezone})` : 'Automatic birthday send is off'}</div></div></div>
        {editingId === emp._id ? <form onSubmit={(event) => saveEdit(event, emp)} className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          <div><label className="label">Full name</label><input className="input" maxLength={120} value={editName} onChange={(e) => setEditName(e.target.value)} required /></div>
          <div><label className="label">Date of birth</label><input type="date" className="input" value={editDob} onChange={(e) => setEditDob(e.target.value)} required /></div>
          <div><label className="label">Profile photo</label><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 p-2"><img src={editPreview || emp.imageUrl} alt="Photo preview" className="h-12 w-12 rounded-md bg-slate-100 object-contain object-center" /><span className="truncate text-xs text-slate-600">{editFile?.name || 'Keep current photo or choose a new image'}</span><input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; if (!f.type.startsWith('image/')) { setNotice({ kind: 'error', text: 'Choose a valid image file.' }); return; } setEditFile(f); setEditPreview(URL.createObjectURL(f)); }} /></label></div>
          <div className="flex gap-2"><button className="btn-primary px-3 py-1.5 text-xs" disabled={!manager || !!busy}>{busy === `edit:${emp._id}` ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => { setEditingId(''); setEditFile(null); setEditPreview(''); }}><X className="h-3.5 w-3.5" /> Cancel</button></div>
        </form> : <div className="mt-3 flex flex-wrap gap-2"><button className="btn-secondary px-2 py-1 text-xs" disabled={!manager || !!busy || !groupId} onClick={() => send(emp)}><Send className="h-3.5 w-3.5" /> Send birthday</button>{manager && <><button title="Edit employee profile" className="btn-secondary px-2 py-1" disabled={!!busy} onClick={() => startEdit(emp)}><Pencil className="h-3.5 w-3.5" /></button><button title="Delete" className="btn px-2 py-1 text-red-600" disabled={!!busy} onClick={() => remove(emp)}><Trash2 className="h-4 w-4" /></button></>}</div>}
      </article>)}</div>}
    </Section></div>
    <div className="mt-5"><Section title="Schedule a one-time birthday image">
      <div className="grid gap-4 sm:grid-cols-4 sm:items-end">
        <div><label className="label">Employee</label><select className="input" value={scheduledEmployee} onChange={(e) => setScheduledEmployee(e.target.value)} disabled={!manager}><option value="">Select employee</option>{view.employees.map((emp) => <option key={emp._id} value={emp._id}>{emp.name}</option>)}</select></div>
        <div><label className="label">Send date ({view.timezone})</label><input type="date" className="input" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} disabled={!manager} /></div>
        <div><label className="label">Send time ({view.timezone})</label><input type="time" className="input" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} disabled={!manager} /></div>
        <button className="btn-primary" disabled={!manager || !scheduledEmployee || !groupId || !scheduledDate || !scheduledTime || !!busy} onClick={scheduleOne}>{busy === 'schedule' ? 'Scheduling…' : 'Schedule image'}</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">Defaults to 12:00 AM. Uses the selected WhatsApp group and birthday greeting above; the employee photo is sent as the image with the greeting in its caption.</p>
      {view.schedules.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full"><thead><tr><th className="th">Send at</th><th className="th">Employee</th><th className="th">Group</th><th className="th">Status</th><th className="th" /></tr></thead><tbody>{view.schedules.map((s) => <tr key={s._id} className="border-b border-slate-100"><td className="td">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: view.timezone }).format(new Date(s.sendAt))}</td><td className="td">{s.employeeName}</td><td className="td">{s.destinationLabel}</td><td className="td"><StatusBadge status={s.status} />{s.error && <div className="text-xs text-red-600">{s.error}</div>}</td><td className="td text-right">{s.status === 'pending' && manager && <button className="btn-danger px-2 py-1 text-xs" onClick={() => cancelOne(s)}>Cancel</button>}</td></tr>)}</tbody></table></div>}
    </Section></div>
    <div className="mt-5"><Section title="Birthday message history">{!view.sends.length ? <p className="text-sm text-slate-500">No birthday messages sent yet.</p> : <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className="th">Employee</th><th className="th">Group</th><th className="th">Date</th><th className="th">Status</th></tr></thead><tbody>{view.sends.map((s) => <tr key={s._id} className="border-b border-slate-100"><td className="td">{s.employeeName}</td><td className="td">{s.destinationLabel}</td><td className="td">{s.dateKey.slice(0, 10)}</td><td className="td"><StatusBadge status={s.status} />{s.error && <div className="text-xs text-red-600">{s.error}</div>}</td></tr>)}</tbody></table></div>}</Section></div>
  </>;
}
