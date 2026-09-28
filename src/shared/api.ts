/**
 * Types shared by the Worker (backend) and the React app (frontend).
 */

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

export const SCAN_STATUSES = ['uploading', 'ready', 'queued', 'running', 'completed', 'failed'] as const;
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
  httpStatus: number | null;
  finalUrl: string | null;
  responseTimeMs: number | null;
  checkedAt: string | null;
}

/** Status filter groups shown as buttons above the results table. */
export const ROW_FILTER_GROUPS = ['all', 'active', 'dead', 'redirected', 'review', 'waiting', 'skipped'] as const;
export type RowFilterGroup = (typeof ROW_FILTER_GROUPS)[number];

export interface RowFilters {
  group: RowFilterGroup;
  /** Exact worksheet name, or '' for all. */
  sheet: string;
  /** HTTP status code, 'none' (no response), or '' for all. */
  http: string;
  /** Text to find in the backlink or target URL. */
  q: string;
}

export interface RowFacets {
  /** Rows per status group, with the sheet/search/HTTP filters applied. */
  groups: Record<RowFilterGroup, number>;
  sheets: string[];
  httpCodes: number[];
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

export interface CheckBatchResponse {
  scan: ScanSummary;
  processed: number;
  remaining: number;
  /** Set when nothing could be checked right now: wait this long before asking again. */
  retryAfterMs?: number;
}
