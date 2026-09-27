import type { ScanStatus } from '../../shared/api';
import { SCAN_STATUS_INFO } from '../../shared/scan-status';
import { Icon, type IconName } from './Icon';

const ICON: Record<'pending' | 'active' | 'dead' | 'review', IconName> = {
  pending: 'dots',
  active: 'check',
  dead: 'cross',
  review: 'alert',
};

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  const info = SCAN_STATUS_INFO[status];
  return (
    <span className={`badge tone-${info.tone}`}>
      <Icon name={ICON[info.tone]} size={14} />
      {info.label}
    </span>
  );
}
