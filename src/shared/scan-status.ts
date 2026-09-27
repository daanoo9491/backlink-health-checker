import type { ScanStatus } from './api';

/** Friendly wording for scan-level states (link-level states are in status.ts). */
export const SCAN_STATUS_INFO: Record<ScanStatus, { label: string; tone: 'pending' | 'active' | 'dead' | 'review' }> = {
  uploading: { label: 'Upload unfinished', tone: 'review' },
  ready: { label: 'Ready to check', tone: 'pending' },
  queued: { label: 'Waiting to start', tone: 'pending' },
  running: { label: 'Checking', tone: 'pending' },
  completed: { label: 'Finished', tone: 'active' },
  failed: { label: 'Failed', tone: 'dead' },
};
