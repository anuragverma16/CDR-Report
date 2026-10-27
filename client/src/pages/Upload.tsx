import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FileSpreadsheet, Trash2, UploadCloud, Wand2 } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Classification, FieldKey, Mapping, Options, PreviewResponse, UploadResult, UploadedFile } from '../lib/types';
import { fmtBytes, fmtDateTime, fmtDuration } from '../lib/format';
import { Alert, Badge, Empty, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';

const DEFAULT_OPTIONS: Options = { dateOrder: 'DMY', durationFormat: 'auto', agentAliases: {} };
const DISP_CATS: { key: keyof Classification['disposition']; label: string }[] = [
  { key: 'interested', label: 'Interested' },
  { key: 'notInterested', label: 'Not Interested' },
  { key: 'callBack', label: 'Call Back' },
  { key: 'answeredDisp', label: 'Answered (Disp)' },
];

export default function Upload() {
  const { can } = useAuth();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadResult>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [messages, setMessages] = useState<{ kind: 'error' | 'warning' | 'success'; text: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    const r = await api.get<{ files: UploadedFile[] }>('/cdr/files');
    setFiles(r.files);
  }, []);
  useEffect(() => { loadFiles().catch((e) => setMessages([{ kind: 'error', text: errMsg(e) }])); }, [loadFiles]);

  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    const bad = arr.filter((f) => !/\.(xlsx|xls|csv)$/i.test(f.name));
    if (bad.length) { setMessages([{ kind: 'error', text: `Only .xlsx, .xls and .csv files are accepted: ${bad.map((f) => f.name).join(', ')}` }]); return; }
    const fd = new FormData();
    arr.forEach((f) => fd.append('files', f));
    setBusy(true);
    setMessages([]);
    try {
      const r = await api.post<{ results: UploadResult[] }>('/cdr/upload', fd);
      const next = { ...uploads };
      const msgs: typeof messages = [];
      for (const res of r.results) {
        if (res.error) msgs.push({ kind: 'error', text: `${res.file.originalName}: ${res.error}` });
        else {
          next[res.file._id] = res;
          msgs.push({ kind: 'success', text: `${res.file.originalName}: ${res.file.rowCount} data rows read.` });
          if (res.warning) msgs.push({ kind: 'warning', text: res.warning });
        }
      }
      setUploads(next);
      setMessages(msgs);
      const firstOk = r.results.find((x) => !x.error);
      if (firstOk) setSelected(firstOk.file._id);
      await loadFiles();
    } catch (e) { setMessages([{ kind: 'error', text: errMsg(e) }]); } finally { setBusy(false); }
  };

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (can('manager')) upload(e.dataTransfer.files); };
  const remove = async (f: UploadedFile) => {
    if (!confirm(`Delete ${f.originalName} and all of its imported records? Reports already generated keep their data.`)) return;
    try { await api.del(`/cdr/files/${f._id}`); if (selected === f._id) setSelected(null); await loadFiles(); } catch (e) { setMessages([{ kind: 'error', text: errMsg(e) }]); }
  };
  const selectedFile = files.find((f) => f._id === selected);

  return (
    <>
      <PageHeader title="Upload CDR" subtitle="Upload Tata Dialer CDR exports (.xlsx, .xls, .csv), map their columns, validate and process them." />
      {can('manager') ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`card mb-6 flex cursor-pointer flex-col items-center justify-center border-2 border-dashed px-6 py-10 text-center transition ${drag ? 'border-vol bg-blue-50' : 'border-slate-300 hover:border-vol/60'}`}
        >
          <input ref={inputRef} type="file" multiple accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
          {busy ? <Spinner label="Uploading and reading files…" /> : (
            <>
              <UploadCloud className="mb-3 h-10 w-10 text-vol" />
              <div className="font-semibold text-slate-800">Drag & drop CDR files here, or click to browse</div>
              <div className="mt-1 text-sm text-slate-500">Multiple files allowed · .xlsx .xls .csv · size limit set on the server</div>
            </>
          )}
        </div>
      ) : <div className="mb-6"><Alert kind="info">Your role can view files but not upload or process them.</Alert></div>}

      {messages.length > 0 && <div className="mb-6 space-y-2">{messages.map((m, i) => <Alert key={i} kind={m.kind}>{m.text}</Alert>)}</div>}

      <Section title="Uploaded files" className="mb-6">
        {files.length === 0 ? <Empty icon={<FileSpreadsheet className="h-10 w-10" />} title="No files uploaded yet" /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-100"><tr><th className="th">File</th><th className="th">Status</th><th className="th">Rows</th><th className="th">Valid / Invalid / Dup.</th><th className="th">Dates</th><th className="th">Uploaded</th><th className="th" /></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f._id} className={`border-b border-slate-50 ${selected === f._id ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}>
                    <td className="td"><button className="text-left font-medium text-ink hover:underline" onClick={() => setSelected(f._id)} disabled={f.status === 'failed'}>{f.originalName}</button><div className="text-xs text-slate-400">{f.fileType.toUpperCase()} · {fmtBytes(f.size)}</div></td>
                    <td className="td"><StatusBadge status={f.status} />{f.error && <div className="mt-1 max-w-xs text-xs text-red-600">{f.error}</div>}</td>
                    <td className="td tabular-nums">{f.rowCount ?? '—'}</td>
                    <td className="td tabular-nums">{f.stats ? `${f.stats.valid} / ${f.stats.invalid} / ${f.stats.duplicatesInFile + f.stats.duplicatesOfImported}` : '—'}</td>
                    <td className="td whitespace-nowrap">{f.dateRange?.from ? (f.dateRange.from === f.dateRange.to ? f.dateRange.from : `${f.dateRange.from} → ${f.dateRange.to}`) : '—'}</td>
                    <td className="td whitespace-nowrap text-xs">{fmtDateTime(f.createdAt)}</td>
                    <td className="td whitespace-nowrap text-right">
                      {f.status !== 'failed' && can('manager') && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setSelected(f._id)}>{f.status === 'processed' ? 'Review' : 'Map & process'}</button>}
                      {can('admin') && <button className="btn ml-1 px-2 py-1 text-slate-400 hover:text-red-600" title="Delete file" onClick={() => remove(f)}><Trash2 className="h-4 w-4" /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {selectedFile && can('manager') && <MappingWizard key={selectedFile._id} file={selectedFile} upload={uploads[selectedFile._id]} onProcessed={loadFiles} />}
    </>
  );
}

function aliasesToText(a: Record<string, string>) { return Object.entries(a || {}).map(([k, v]) => `${k} = ${v}`).join('\n'); }
function textToAliases(t: string) {
  const out: Record<string, string> = {};
  t.split('\n').forEach((line) => { const [k, ...v] = line.split('='); if (k?.trim() && v.join('=').trim()) out[k.trim()] = v.join('=').trim(); });
  return out;
}

function MappingWizard({ file, upload, onProcessed }: { file: UploadedFile; upload?: UploadResult; onProcessed: () => Promise<void> }) {
  const [mapping, setMapping] = useState<Mapping>(file.mapping || upload?.suggestion?.mapping || {});
  const [options, setOptions] = useState<Options>({ ...DEFAULT_OPTIONS, ...(file.options || upload?.suggestion?.options || {}) });
  const [aliasText, setAliasText] = useState(aliasesToText(options.agentAliases));
  const [classification, setClassification] = useState<Classification | null>(file.classification || upload?.suggestion?.classification || null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [reportDate, setReportDate] = useState(file.reportDate || '');
  const [saveAs, setSaveAs] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'process'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<UploadedFile | null>(null);
  const mappingSource = file.mapping ? 'Mapping used when this file was processed' : upload?.suggestion?.source;

  const runPreview = useCallback(async (m: Mapping, cls: Classification | null, keepCls: boolean) => {
    setBusy('preview');
    setError('');
    try {
      const opts = { ...options, agentAliases: textToAliases(aliasText) };
      const r = await api.post<PreviewResponse & { suggestedMapping?: Mapping }>('/cdr/preview', { fileId: file._id, mapping: m, options: opts, ...(keepCls && cls ? { classification: cls } : {}) });
      setPreview(r);
      if (!Object.values(m).some(Boolean) && r.suggestedMapping) setMapping(r.suggestedMapping);
      if (r.ok && r.classification) setClassification(r.classification);
      if (r.ok && !reportDate && r.suggestedReportDate) setReportDate(r.suggestedReportDate);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  }, [aliasText, file._id, options, reportDate]);

  // First load: read the file and validate with the current/suggested mapping
  useEffect(() => { runPreview(mapping, classification, !!classification); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const setStatus = (value: string, to: 'answered' | 'missed' | 'none') => {
    if (!classification) return;
    const st = { answered: classification.status.answered.filter((v) => v !== value), missed: classification.status.missed.filter((v) => v !== value) };
    if (to !== 'none') st[to].push(value);
    setClassification({ ...classification, status: st });
  };
  const toggleDisp = (value: string, cat: keyof Classification['disposition']) => {
    if (!classification) return;
    const list = classification.disposition[cat] || [];
    setClassification({ ...classification, disposition: { ...classification.disposition, [cat]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] } });
  };

  const process = async () => {
    if (!classification) return;
    if (file.status === 'processed' && !confirm('This file was already processed. Re-processing replaces its records (reports already generated are not changed). Continue?')) return;
    setBusy('process');
    setError('');
    try {
      const r = await api.post<{ file: UploadedFile }>('/cdr/process', {
        fileId: file._id, mapping, options: { ...options, agentAliases: textToAliases(aliasText) }, classification,
        ...(reportDate && { reportDate }), ...(saveAs.trim() && { saveMappingAs: saveAs.trim() }), replace: file.status === 'processed',
      });
      setDone(r.file);
      await onProcessed();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  };

  const headers = preview?.headers || file.headers || [];
  const s = preview?.summary;
  const unclassified = s?.statuses.filter((x) => !classification?.status.answered.includes(x.value) && !classification?.status.missed.includes(x.value)) || [];

  return (
    <div className="space-y-6">
      <Section title={<>Preview · <span className="font-normal text-slate-500">{file.originalName} — first 20 rows</span></>}>
        {!preview && busy && <Spinner label="Reading file…" />}
        {preview && (
          <div className="-mx-5 max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-100"><tr><th className="th">#</th>{headers.map((h) => <th key={h} className="th whitespace-nowrap normal-case">{h}</th>)}</tr></thead>
              <tbody>{preview.preview.map((r) => <tr key={r.rowNumber} className="border-b border-slate-50 odd:bg-surface even:bg-slate-50/60"><td className="td text-slate-400">{r.rowNumber}</td>{headers.map((h) => <td key={h} className="td whitespace-nowrap">{r.values[h]}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="1 · Column mapping" actions={mappingSource && <Badge tone="blue"><Wand2 className="mr-1 h-3 w-3" />{mappingSource}</Badge>}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(preview?.fields || []).map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}{f.required ? ' *' : ' (optional)'}</label>
              <select className={`input ${f.required && !mapping[f.key] ? 'border-red-300' : ''}`} value={mapping[f.key] || ''} onChange={(e) => setMapping({ ...mapping, [f.key as FieldKey]: e.target.value || null })}>
                <option value="">{f.required ? '— select column —' : '— not in this file —'}</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-3">
          <div><label className="label">Date format in file</label>
            <select className="input" value={options.dateOrder} onChange={(e) => setOptions({ ...options, dateOrder: e.target.value as Options['dateOrder'] })}>
              <option value="DMY">Day/Month/Year (14/10/2026)</option><option value="MDY">Month/Day/Year (10/14/2026)</option><option value="YMD">Year-Month-Day</option>
            </select>
          </div>
          <div><label className="label">Duration values</label>
            <select className="input" value={options.durationFormat} onChange={(e) => setOptions({ ...options, durationFormat: e.target.value as Options['durationFormat'] })}>
              <option value="auto">Auto-detect (HH:MM:SS or seconds)</option><option value="seconds">Plain numbers are seconds</option><option value="minutes">Plain numbers are minutes</option><option value="hms">HH:MM:SS text</option>
            </select>
          </div>
          <div><label className="label">Agent name aliases (optional)</label>
            <textarea className="input h-20 font-mono text-xs" placeholder={'variant = Canonical Name'} value={aliasText} onChange={(e) => setAliasText(e.target.value)} />
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">Case, dots, underscores and extra spaces in agent names are normalized automatically. Naive timestamps are read as Asia/Kolkata time.</p>
        <div className="mt-4"><button className="btn-primary" onClick={() => runPreview(mapping, classification, false)} disabled={!!busy}>{busy === 'preview' ? <Spinner /> : null} Validate file with this mapping</button></div>
        {preview?.mappingErrors?.length ? <div className="mt-4"><Alert kind="error" title="Mapping incomplete">{preview.mappingErrors.map((e) => <div key={e}>{e}</div>)}</Alert></div> : null}
      </Section>

      {preview?.ok && s && classification && (
        <>
          <Section title="2 · Validation">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[['Rows in file', s.totalRows, 'text-slate-900'], ['Valid & new', s.valid, 'text-dur'], ['Invalid', s.invalid, s.invalid ? 'text-red-600' : 'text-slate-900'], ['Duplicates in file', s.duplicatesInFile, s.duplicatesInFile ? 'text-amber-600' : 'text-slate-900'], ['Already imported', s.duplicatesOfImported, s.duplicatesOfImported ? 'text-amber-600' : 'text-slate-900']].map(([l, v, c]) => (
                <div key={l as string} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{l}</div><div className={`text-xl font-bold tabular-nums ${c}`}>{v}</div></div>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {!s.usesCallId && <Alert kind="warning">No unique Call ID column mapped — duplicates are detected by agent + start time + number + talk time + status, which is less reliable.</Alert>}
              {!!preview.missingOptionalFields?.length && <Alert kind="info">Not in this file: {preview.missingOptionalFields.join(', ')}. These will show as N/A in reports (never as zero).</Alert>}
              {s.duplicatesOfImported > 0 && <Alert kind="warning">{s.duplicatesOfImported} record(s) already exist in previously imported files. They are kept for the audit trail but counted once in reports.</Alert>}
              {s.invalidSamples.length > 0 && <Alert kind="error" title={`${s.invalid} invalid row(s) will be excluded`}>{s.invalidSamples.slice(0, 8).map((x) => <div key={x.row}>Row {x.row}: {x.errors.join('; ')}</div>)}{s.invalid > 8 && <div>…and more (full list in the Data Quality sheet)</div>}</Alert>}
            </div>
            <div className="mt-4 text-sm text-slate-600"><b>{s.agents.length}</b> agent(s): {s.agents.join(', ')}</div>
            <div className="mt-1 text-sm text-slate-600">Dates found: {s.dates.map((d) => `${d.value} (${d.count})`).join(', ') || '—'}</div>
          </Section>

          <Section title="3 · Call status & disposition classification">
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <div className="label">Call statuses found</div>
                <div className="space-y-1.5">
                  {s.statuses.map((x) => {
                    const v = classification.status.answered.includes(x.value) ? 'answered' : classification.status.missed.includes(x.value) ? 'missed' : 'none';
                    return (
                      <div key={x.value} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5">
                        <span className="text-sm"><b>{x.value}</b> <span className="text-slate-400">({x.count})</span></span>
                        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={v} onChange={(e) => setStatus(x.value, e.target.value as 'answered' | 'missed' | 'none')}>
                          <option value="answered">Answered</option><option value="missed">Missed</option><option value="none">Not mapped</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
                {unclassified.length > 0 && <div className="mt-2"><Alert kind="warning">Unmapped statuses count in Total Calls but in neither Answered nor Missed, and the report flags them.</Alert></div>}
              </div>
              <div>
                <div className="label">Dispositions found (a value may belong to several categories)</div>
                {s.dispositions.length === 0 ? <div className="text-sm text-slate-500">No disposition values{mapping.disposition ? '' : ' — disposition column not mapped'}.</div> : (
                  <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                    {s.dispositions.map((x) => (
                      <div key={x.value} className="rounded-lg border border-slate-200 px-3 py-1.5">
                        <div className="text-sm"><b>{x.value}</b> <span className="text-slate-400">({x.count})</span></div>
                        <div className="mt-1 flex flex-wrap gap-3">
                          {DISP_CATS.map((c) => (
                            <label key={c.key} className="flex items-center gap-1 text-xs text-slate-600">
                              <input type="checkbox" checked={!!classification.disposition[c.key]?.includes(x.value)} onChange={() => toggleDisp(x.value, c.key)} /> {c.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4"><button className="btn-secondary" onClick={() => runPreview(mapping, classification, true)} disabled={!!busy}>Re-check with this classification</button></div>
          </Section>

          {preview.normalizedSample && (
            <Section title="Normalized sample (first 20 rows)">
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50"><tr>{['Row', 'Agent', 'Date', 'Status', 'Disposition → category', 'Talk', 'Hold', 'Wrap', 'Notes'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                  <tbody>
                    {preview.normalizedSample.map((r) => (
                      <tr key={r.row} className={`border-b border-slate-50 ${r.valid ? '' : 'bg-red-50'}`}>
                        <td className="td">{r.row}</td><td className="td font-medium">{r.agent || '—'}</td><td className="td">{r.date || '—'}</td>
                        <td className="td">{r.statusLabel} <Badge tone={r.status === 'answered' ? 'green' : r.status === 'missed' ? 'red' : 'amber'}>{r.status}</Badge></td>
                        <td className="td">{r.disposition || '—'}{r.dispositionClasses.length ? ` → ${r.dispositionClasses.join(', ')}` : ''}</td>
                        <td className="td tabular-nums">{fmtDuration(r.talkSec)}</td><td className="td tabular-nums">{fmtDuration(r.holdSec)}</td><td className="td tabular-nums">{fmtDuration(r.wrapSec)}</td>
                        <td className="td text-red-600">{[...r.errors, ...r.warnings].join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="4 · Process">
            <div className="grid gap-4 sm:grid-cols-3">
              <div><label className="label">Report date</label><input type="date" className="input" value={reportDate} onChange={(e) => setReportDate(e.target.value)} /></div>
              <div className="sm:col-span-2"><label className="label">Save this mapping for future files (optional)</label><input className="input" placeholder="e.g. Tata Dialer standard export" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} maxLength={80} /></div>
            </div>
            {error && <div className="mt-4"><Alert kind="error">{error}</Alert></div>}
            {done ? (
              <div className="mt-4">
                <Alert kind="success" title="CDR processed">
                  {done.stats?.valid} valid new records, {done.stats?.invalid} invalid, {(done.stats?.duplicatesInFile || 0) + (done.stats?.duplicatesOfImported || 0)} duplicates.{' '}
                  <Link className="font-semibold underline" to={`/reports?file=${done._id}&date=${done.reportDate || ''}`}>Generate the agent report →</Link>
                </Alert>
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-3">
                <button className="btn-green" onClick={process} disabled={!!busy || s.valid + s.duplicatesOfImported === 0}><CheckCircle2 className="h-4 w-4" /> {busy === 'process' ? 'Processing…' : file.status === 'processed' ? 'Re-process CDR' : 'Process CDR'}</button>
              </div>
            )}
          </Section>
        </>
      )}
      {error && !preview?.ok && <Alert kind="error">{error}</Alert>}
    </div>
  );
}
