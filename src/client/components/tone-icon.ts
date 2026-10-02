import type { StatusTone } from '../../shared/status';
import type { IconName } from './Icon';

/** One icon shape per tone, so colour is never the only cue. */
export const TONE_ICON: Record<StatusTone, IconName> = {
  active: 'check',
  dead: 'cross',
  review: 'alert',
  redirected: 'arrow',
  pending: 'dots',
};
