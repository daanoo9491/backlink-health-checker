import { STATUS_INFO, type LinkStatus } from '../../shared/status';
import { Icon } from './Icon';
import { TONE_ICON } from './tone-icon';

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
