import { INDEX_GROUP, type RowFilterGroup, type ScanTool } from '../../shared/api';
import { INDEX_STATUSES, INDEX_STATUS_INFO } from '../../shared/index-status';
import { ISSUE_CATEGORIES } from '../../shared/issues';

export interface GroupOption {
  key: RowFilterGroup;
  label: string;
  tone?: string;
  /** Issue categories: shown only while selected, from the Issues list. */
  sub?: boolean;
}

export const LINK_GROUPS: GroupOption[] = [
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
export const INDEX_GROUPS: GroupOption[] = [
  { key: 'all', label: 'All' },
  ...INDEX_STATUSES.map((s) => ({
    key: INDEX_GROUP[s],
    label: INDEX_STATUS_INFO[s].label,
    tone: INDEX_STATUS_INFO[s].tone,
  })),
  { key: 'waiting', label: 'Waiting', tone: 'pending' },
  { key: 'skipped', label: 'Skipped', tone: 'pending' },
];

export function groupLabel(key: RowFilterGroup, tool: ScanTool): string {
  return (
    (tool === 'index' ? INDEX_GROUPS : LINK_GROUPS).find((g) => g.key === key)?.label ??
    LINK_GROUPS.find((g) => g.key === key)?.label ??
    key
  );
}
