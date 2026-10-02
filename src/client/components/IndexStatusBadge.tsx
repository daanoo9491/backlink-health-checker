import { INDEX_STATUS_INFO, type IndexStatus } from '../../shared/index-status';
import { Icon } from './Icon';
import { TONE_ICON } from './tone-icon';

/** Index Checker result badge: colour + icon + text, description as a tooltip. */
export function IndexStatusBadge({ status }: { status: IndexStatus }) {
  const info = INDEX_STATUS_INFO[status];
  return (
    <span className={`badge tone-${info.tone}`} title={info.description}>
      <Icon name={TONE_ICON[info.tone]} size={14} />
      {info.label}
    </span>
  );
}
