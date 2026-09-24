import { STATUS_INFO, type LinkStatus, type StatusTone } from '../../shared/status';
import { Icon, type IconName } from './Icon';

const TONE_ICON: Record<StatusTone, IconName> = {
  active: 'check',
  dead: 'cross',
  review: 'alert',
  redirected: 'arrow',
  pending: 'dots',
};

/**
 * Status badge: colour + icon shape + text, so it works for colour-blind
 * users and screen readers. The plain-English description is a tooltip.
 */
export function StatusBadge({ status }: { status: LinkStatus }) {
  const info = STATUS_INFO[status];
  return (
    <span className={`badge tone-${info.tone}`} title={info.description}>
      <Icon name={TONE_ICON[info.tone]} size={14} />
      {info.label}
    </span>
  );
}
