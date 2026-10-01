/**
 * Types shared by the Worker (backend) and the React app (frontend).
 */
import type { LinkStatus } from './status';

export interface HealthResponse {
  status: 'ok';
  app: string;
  environment: string;
  version: string;
  timestamp: string;
}

/** Every API error has this shape. Never contains stack traces. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface SessionUser {
  id: string;
  email: string;
}

export interface MeResponse {
  user: SessionUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

// ---------- Scans ----------

export const SCAN_STATUSES = ['uploading', 'ready', 'queued', 'running', 'paused', 'completed', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export interface SheetInfo {
  name: string;
  hidden: boolean;
  status: 'used' | 'no-backlinks-column' | 'empty';
  headerRow?: number;
  backlinksHeader?: string;
  rows: number;
  valid: number;
  invalid: number;
  blank: number;
}

/** Step 1 of saving a scan: describe it. Rows and URLs follow in chunks. */
export interface CreateScanRequest {
  fileName: string;
  fileSize: number;
  worksheets: number;
  sheets: SheetInfo[];
  headers: string[];
  totalRows: number;
  uniqueUrls: number;
  blankRows: number;
}

export interface CreateScanResponse {
  id: string;
}

/** Step 2: unique URLs, in order, starting at `offset`. */
export interface AddUrlsRequest {
  offset: number;
  urls: string[];
}

export interface ScanRowInput {
  sheet: string;
  row: number;
  value: string;
  /** Index into the scan's unique URLs; absent for invalid rows. */
  urlIndex?: number;
  duplicate?: boolean;
  invalidReason?: string;
  targetUrl?: string;
  anchorText?: string;
  cells: Record<string, string>;
}

/** Step 3: source rows, in any order. */
export interface AddRowsRequest {
  rows: ScanRowInput[];
}

export const SCAN_LIMITS = {
  maxRows: 20_000,
  maxUniqueUrls: 20_000,
  urlsPerRequest: 2_000,
  rowsPerRequest: 1_000,
  maxCellLength: 1_000,
  maxCellsPerRow: 256,
  maxHeaderCount: 256,
  maxSheets: 100,
} as const;

export interface ScanSummary {
  id: string;
  fileName: string;
  fileSize: number;
  status: ScanStatus;
  worksheets: number;
  totalRows: number;
  validUrls: number;
  invalidRows: number;
  blankRows: number;
  uniqueUrls: number;
  duplicateRows: number;
  checkedCount: number;
  activeCount: number;
  deadCount: number;
  soft404Count: number;
  redirectedCount: number;
  blockedCount: number;
  errorCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Last sign of life from background checking (null before it starts). */
  heartbeatAt: string | null;
}

export interface ScanDetail extends ScanSummary {
  sheets: SheetInfo[];
  headers: string[];
}

export interface ScanListResponse {
  scans: ScanSummary[];
}

export interface ScanRowView {
  sheet: string;
  row: number;
  value: string;
  url: string | null;
  duplicate: boolean;
  invalidReason: string | null;
  targetUrl: string | null;
  anchorText: string | null;
  status: string | null;
  checkReason: string | null;
  /** The backlink page's title, when it loaded as HTML. */
  pageTitle: string | null;
  /** Set while a temporary failure waits for its automatic retry. */
  retryAt: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  responseTimeMs: number | null;
  checkedAt: string | null;
}

/**
 * Status filter groups. The main ones are buttons above the results table;
 * 'unreachable', 'site_error' and 'refused' split "Need a look" into issue
 * categories (see shared/issues.ts). A link waiting for an automatic retry
 * counts as waiting only, never also as an issue.
 */
export const ROW_FILTER_GROUPS = [
  'all',
  'active',
  'dead',
  'redirected',
  'review',
  'unreachable',
  'site_error',
  'refused',
  'waiting',
  'skipped',
] as const;
export type RowFilterGroup = (typeof ROW_FILTER_GROUPS)[number];

/** Columns the results table can be sorted by. 'row' = order in the workbook. */
export const ROW_SORTS = ['row', 'url', 'status', 'http'] as const;
export type RowSort = (typeof ROW_SORTS)[number];
export type SortDir = 'asc' | 'desc';

export interface RowFilters {
  group: RowFilterGroup;
  /** Exact worksheet name, or '' for all. */
  sheet: string;
  /** HTTP status code, 'none' (no response), or '' for all. */
  http: string;
  /** Text to find in the backlink or target URL. */
  q: string;
  sort: RowSort;
  dir: SortDir;
}

export interface RowFacets {
  /** Rows per status group, with the sheet/search/HTTP filters applied. */
  groups: Record<RowFilterGroup, number>;
  sheets: string[];
  httpCodes: number[];
  /**
   * Unique links per result, for the whole scan (filters don't apply).
   * Links waiting for an automatic retry are counted in `retrying` only.
   */
  links: { byStatus: Partial<Record<LinkStatus, number>>; retrying: number };
}

export interface ScanRowsResponse {
  rows: ScanRowView[];
  page: number;
  pageSize: number;
  /** Rows matching all filters. */
  total: number;
  facets: RowFacets;
}

export interface DashboardSummary {
  totalScans: number;
  urlsChecked: number;
  activeLinks: number;
  deadLinks: number;
  issuesFound: number;
  recentScans: ScanSummary[];
}
