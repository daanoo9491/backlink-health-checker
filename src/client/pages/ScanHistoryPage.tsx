import { Link } from 'react-router';
import { LINK_STATUSES, STATUS_INFO } from '../../shared/status';
import { StatusBadge } from '../components/StatusBadge';

// Statuses users will actually see in results (PENDING/CHECKING are in-progress states).
const GUIDE = LINK_STATUSES.filter((s) => s !== 'CHECKING');

export function ScanHistoryPage() {
  return (
    <div className="stack-lg">
      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="visually-hidden">
          Your scans
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">File name</th>
                <th scope="col">Scan date</th>
                <th scope="col" className="num">
                  Links checked
                </th>
                <th scope="col" className="num">
                  Active
                </th>
                <th scope="col" className="num">
                  Dead
                </th>
                <th scope="col" className="num">
                  Need a look
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={7}>
                  <div className="empty empty-inline">
                    <p className="empty-title">No scans yet</p>
                    <p>Scans you run are saved here, so you can open or download them later.</p>
                    <Link to="/scans/new" className="button button-secondary">
                      Start a new scan
                    </Link>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="guide-heading">
        <h2 id="guide-heading" className="section-title">
          What the results mean
        </h2>
        <dl className="status-guide">
          {GUIDE.map((s) => (
            <div key={s}>
              <dt>
                <StatusBadge status={s} />
              </dt>
              <dd>{STATUS_INFO[s].description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
