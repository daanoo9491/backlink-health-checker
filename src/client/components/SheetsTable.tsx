import type { SheetInfo } from '../../shared/api';
import { formatNumber } from '../lib/format';

function outcome(s: SheetInfo): string {
  if (s.status === 'empty') return 'Skipped: the sheet is empty';
  if (s.status === 'no-backlinks-column') return 'Skipped: no “Backlinks” column';
  return `Read the “${s.backlinksHeader}” column (headings on row ${s.headerRow})`;
}

export function SheetsTable({ sheets }: { sheets: SheetInfo[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Sheet</th>
            <th scope="col">What we did</th>
            <th scope="col" className="num">
              Valid links
            </th>
            <th scope="col" className="num">
              Invalid
            </th>
          </tr>
        </thead>
        <tbody>
          {sheets.map((s) => (
            <tr key={s.name}>
              <th scope="row" className="cell-strong">
                {s.name}
                {s.hidden && <span className="tag">hidden</span>}
              </th>
              <td>{outcome(s)}</td>
              <td className="num">{s.status === 'used' ? formatNumber(s.valid) : '—'}</td>
              <td className="num">{s.status === 'used' ? formatNumber(s.invalid) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
