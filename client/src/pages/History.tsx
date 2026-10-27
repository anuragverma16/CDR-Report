import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, History as HistoryIcon, ImageIcon } from 'lucide-react';
import { api, downloadFile, errMsg } from '../lib/api';
import type { Report } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Alert, Badge, Empty, PageHeader, Spinner, StatusBadge } from '../components/ui';

export default function History() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get<{ reports: Report[] }>('/reports').then((r) => setReports(r.reports)).catch((e) => setError(errMsg(e))); }, []);
  const dl = (id: string, kind: 'excel' | 'image') => downloadFile(`/reports/${id}/${kind}`, `report.${kind === 'excel' ? 'xlsx' : 'png'}`).catch((e) => setError(errMsg(e)));

  return (
    <>
      <PageHeader title="Report History" subtitle="Every generated report with its source files, files and WhatsApp delivery status." />
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}
      {!reports ? <Spinner label="Loading…" /> : reports.length === 0 ? <Empty icon={<HistoryIcon className="h-10 w-10" />} title="No reports yet"><Link to="/reports" className="text-vol underline">Generate your first report</Link></Empty> : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-100 bg-slate-50"><tr>{['Report date', 'Source files', 'Agents', 'Total calls', 'Generated', 'Type', 'Excel', 'PNG', 'WhatsApp', ''].map((h) => <th key={h} className="th whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r._id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="td whitespace-nowrap font-semibold text-ink">{r.reportDate}</td>
                  <td className="td max-w-xs"><div className="truncate" title={r.sourceNames.join(', ')}>{r.sourceNames.join(', ')}</div></td>
                  <td className="td tabular-nums">{r.agentCount}</td>
                  <td className="td tabular-nums">{r.totalCalls}</td>
                  <td className="td whitespace-nowrap text-xs">{fmtDateTime(r.createdAt)}{r.trigger === 'schedule' && <div><Badge tone="blue">scheduled</Badge></div>}</td>
                  <td className="td"><Badge tone={r.type === 'combined' ? 'maroon' : 'slate'}>{r.type}</Badge></td>
                  <td className="td"><button className="text-vol hover:text-ink" title="Download Excel" onClick={() => dl(r._id, 'excel')}><Download className="h-4 w-4" /></button></td>
                  <td className="td">{r.imageStatus === 'ready' ? <button className="text-vol hover:text-ink" title="Download PNG" onClick={() => dl(r._id, 'image')}><ImageIcon className="h-4 w-4" /></button> : <Badge tone="red">failed</Badge>}</td>
                  <td className="td"><StatusBadge status={r.deliveryStatus} /></td>
                  <td className="td"><Link to={`/reports/${r._id}`} className="btn-secondary px-2.5 py-1 text-xs">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
