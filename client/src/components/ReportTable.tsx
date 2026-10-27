import type { AgentRow, Availability, ReportLayout } from '../lib/types';
import { durCell } from '../lib/format';

/** On-screen version of the agent report. Mirrors the Excel / PNG layout and uses the same data. */
const DEFAULT_LAYOUT: ReportLayout = { holdLabel: 'Hold Time', wrapLabel: 'Wrap Up Time', dispositions: true };

export function ReportTable({ title, agents, total, availability, layout = DEFAULT_LAYOUT }: { title?: string; agents: AgentRow[]; total: AgentRow; availability: Availability; layout?: ReportLayout }) {
  const showDisp = layout.dispositions;
  const disp = (v: number) => (availability.disposition === 'none' ? 'N/A' : v);
  const cell = 'border border-grid px-3 py-2 text-center whitespace-nowrap';
  return (
    <div className="overflow-x-auto rounded-lg border border-grid">
      {title && <div className="bg-navy px-4 py-3 text-center text-base font-bold text-white sm:text-lg">{title}</div>}
      <table className="w-full border-collapse text-sm">
        <thead className="text-white">
          <tr>
            <th rowSpan={2} className={`${cell} bg-navy min-w-40 text-base`}>Agent</th>
            <th colSpan={3} className={`${cell} bg-vol`}>Call Volume</th>
            <th colSpan={3} className={`${cell} bg-dur`}>Duration</th>
            {showDisp && <th colSpan={4} className={`${cell} bg-disp`}>Dispositions</th>}
          </tr>
          <tr className="text-xs">
            {['Total Calls', 'Answered', 'Missed'].map((h) => <th key={h} className={`${cell} bg-vol-sub`}>{h}</th>)}
            {['Actual Talk Time', layout.holdLabel, layout.wrapLabel].map((h) => <th key={h} className={`${cell} bg-dur-sub`}>{h}</th>)}
            {showDisp && ['Interested', 'Not Interested', 'Call Back', 'Answered (Disp)'].map((h) => <th key={h} className={`${cell} bg-disp-sub`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => {
            const bg = i % 2 === 0 ? 'bg-rowalt' : 'bg-surface';
            return (
              <tr key={a.agent} className={bg}>
                <td className={`${cell} text-left font-bold`}>{a.agent}</td>
                <td className={cell}>{a.totalCalls}</td>
                <td className={cell}>{a.answered}</td>
                <td className={cell}>{a.missed}</td>
                <td className={`${cell} font-bold text-talk`}>{durCell(a.talkSec, availability.talk)}</td>
                <td className={cell}>{durCell(a.holdSec, availability.hold)}</td>
                <td className={cell}>{durCell(a.wrapSec, availability.wrap)}</td>
                {showDisp && <>
                  <td className={cell}>{disp(a.interested)}</td>
                  <td className={`${cell} bg-ni`}>{disp(a.notInterested)}</td>
                  <td className={`${cell} bg-ni`}>{disp(a.callBack)}</td>
                  <td className={`${cell} bg-ansd`}>{disp(a.answeredDisp)}</td>
                </>}
              </tr>
            );
          })}
          <tr className="bg-navy font-bold text-white">
            <td className={`${cell} text-left`}>TOTAL</td>
            <td className={cell}>{total.totalCalls}</td>
            <td className={cell}>{total.answered}</td>
            <td className={cell}>{total.missed}</td>
            <td className={cell}>{durCell(total.talkSec, availability.talk)}</td>
            <td className={cell}>{durCell(total.holdSec, availability.hold)}</td>
            <td className={cell}>{durCell(total.wrapSec, availability.wrap)}</td>
            {showDisp && <>
              <td className={cell}>{disp(total.interested)}</td>
              <td className={cell}>{disp(total.notInterested)}</td>
              <td className={cell}>{disp(total.callBack)}</td>
              <td className={cell}>{disp(total.answeredDisp)}</td>
            </>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
