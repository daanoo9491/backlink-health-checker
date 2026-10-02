import { useEffect, useId, useState } from 'react';
import type { RowFacets, RowFilterGroup, RowFilters } from '../../shared/api';
import { INDEX_GROUP, type ScanTool } from '../../shared/api';
import { INDEX_STATUSES, INDEX_STATUS_INFO } from '../../shared/index-status';
import { ISSUE_CATEGORIES } from '../../shared/issues';
import { formatNumber } from '../lib/format';

/** `sub` groups (issue categories) appear only while selected, from the Issues list. */
const GROUPS: { key: RowFilterGroup; label: string; tone?: string; sub?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active', tone: 'active' },
  { key: 'dead', label: 'Dead', tone: 'dead' },
  { key: 'redirected', label: 'Redirected', tone: 'redirected' },
  { key: 'review', label: 'Need a look', tone: 'review' },
  ...ISSUE_CATEGORIES.filter((c) => c.tone === 'review').map((c) => ({
    key: c.key as RowFilterGroup,
    label: c.label,
    tone: 'review',
    sub: true,
  })),
  { key: 'waiting', label: 'Waiting', tone: 'pending' },
  { key: 'skipped', label: 'Skipped', tone: 'pending' },
];

/** Index Checker scans filter by index result instead. */
const INDEX_GROUPS: { key: RowFilterGroup; label: string; tone?: string; sub?: boolean }[] = [
  { key: 'all', label: 'All' },
  ...INDEX_STATUSES.map((s) => ({
    key: INDEX_GROUP[s],
    label: INDEX_STATUS_INFO[s].label,
    tone: INDEX_STATUS_INFO[s].tone,
  })),
  { key: 'waiting', label: 'Waiting', tone: 'pending' },
  { key: 'skipped', label: 'Skipped', tone: 'pending' },
];

interface Props {
  filters: RowFilters;
  facets: RowFacets | null;
  onChange: (next: Partial<RowFilters>) => void;
  tool?: ScanTool;
}

export function RowFilterBar({ filters, facets, onChange, tool = 'links' }: Props) {
  const searchId = useId();
  const sheetId = useId();
  const httpId = useId();
  const [text, setText] = useState(filters.q);

  // If the search is changed from outside (e.g. "Clear filters" in the table,
  // or the back button), show that in the box too.
  const [seenQ, setSeenQ] = useState(filters.q);
  if (filters.q !== seenQ) {
    setSeenQ(filters.q);
    if (text.trim() !== filters.q) setText(filters.q);
  }

  // Search as you type, but wait for a short pause first.
  useEffect(() => {
    if (text.trim() === filters.q) return;
    const t = setTimeout(() => onChange({ q: text.trim() }), 300);
    return () => clearTimeout(t);
  }, [text, filters.q, onChange]);

  const active = filters.group !== 'all' || filters.sheet || filters.http || filters.q;
  // Hide groups that are empty (except All and the one selected) to keep the bar short.
  const visible = (tool === 'index' ? INDEX_GROUPS : GROUPS).filter(
    (g) => g.key === 'all' || g.key === filters.group || (!g.sub && (!facets || facets.groups[g.key] > 0)),
  );

  return (
    <div className="filter-bar">
      <div className="filter-groups" role="group" aria-label="Filter by status">
        {visible.map((g) => {
          const selected = filters.group === g.key;
          return (
            <button
              key={g.key}
              type="button"
              className={`chip${g.tone ? ` chip-${g.tone}` : ''}${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onChange({ group: g.key })}
            >
              {g.label}
              {facets && <span className="chip-count">{formatNumber(facets.groups[g.key])}</span>}
            </button>
          );
        })}
      </div>

      <div className="filter-fields">
        <div className="filter-field filter-search">
          <label htmlFor={searchId}>Search links and page titles</label>
          <input
            id={searchId}
            type="search"
            placeholder="e.g. medium.com"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
          />
        </div>
        {facets && facets.sheets.length > 1 && (
          <div className="filter-field">
            <label htmlFor={sheetId}>Sheet</label>
            <select id={sheetId} value={filters.sheet} onChange={(e) => onChange({ sheet: e.target.value })}>
              <option value="">All sheets</option>
              {facets.sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
        {facets && facets.httpCodes.length > 0 && (
          <div className="filter-field">
            <label htmlFor={httpId}>HTTP code</label>
            <select id={httpId} value={filters.http} onChange={(e) => onChange({ http: e.target.value })}>
              <option value="">Any</option>
              {facets.httpCodes.map((c) => (
                <option key={c} value={String(c)}>
                  {c}
                </option>
              ))}
              <option value="none">No response</option>
            </select>
          </div>
        )}
        {active && (
          <button
            type="button"
            className="button button-quiet button-small filter-clear"
            onClick={() => {
              setText('');
              onChange({ group: 'all', sheet: '', http: '', q: '' });
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
