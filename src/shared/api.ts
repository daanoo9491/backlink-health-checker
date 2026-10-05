/**
 * Types shared by the Worker (backend) and the React app (frontend).
 */
import type { IndexEvidence, IndexSource, IndexStatus } from './index-status';
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
/** Which tool a scan belongs to. */
export const SCAN_TOOLS = ['links', 'index'] as const;
export type ScanTool = (typeof SCAN_TOOLS)[number];

export interface CreateScanRequest {
  /** Defaults to 'links' (Link Health). */
  tool?: ScanTool;
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
  tool: ScanTool;
  /** For an index check made from a Link Health scan: that scan. */
  sourceScanId: string | null;
  indexableCount: number;
  /** Blocked from indexing, crawling blocked, canonical elsewhere, not reachable. */
  indexIssueCount: number;
  indexUnknownCount: number;
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
  /** Index Checker scans only. */
  indexStatus: IndexStatus | null;
  indexReason: string | null;
  indexEvidence: IndexEvidence[] | null;
  /** Google Search Console's answer, or our crawler's signals. */
  indexSource: IndexSource | null;
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
  // Index Checker results
  'indexed',
  'not_indexed',
  'indexable',
  'noindex',
  'robots_blocked',
  'canonical_elsewhere',
  'not_reachable',
  'index_unknown',
  'waiting',
  'skipped',
] as const;
export type RowFilterGroup = (typeof ROW_FILTER_GROUPS)[number];

/** Filter group for each index result. */
export const INDEX_GROUP: Record<IndexStatus, RowFilterGroup> = {
  INDEXED: 'indexed',
  NOT_INDEXED: 'not_indexed',
  INDEXABLE: 'indexable',
  NOINDEX: 'noindex',
  ROBOTS_BLOCKED: 'robots_blocked',
  CANONICAL_ELSEWHERE: 'canonical_elsewhere',
  NOT_REACHABLE: 'not_reachable',
  UNKNOWN: 'index_unknown',
};

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
  /** Unique links per index result (Index Checker scans), excluding links waiting for a retry. */
  index: Partial<Record<IndexStatus, number>>;
  /** Index checks: links waiting for the browser helper's Google search. */
  googlePending: number;
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
  /** Link Health scans only; index checks are counted separately. */
  totalScans: number;
  urlsChecked: number;
  activeLinks: number;
  deadLinks: number;
  issuesFound: number;
  recentScans: ScanSummary[];
  indexChecks: number;
  recentIndexChecks: ScanSummary[];
}

/** Settings: is Search Console connected, and which sites can it see? */
export interface SearchConsoleStatus {
  configured: boolean;
  /** The service account's email, to add as a user in Search Console. */
  email: string | null;
  properties: { siteUrl: string; permissionLevel: string; usedToday: number }[];
  /** URL inspections allowed per property per day (Google's limit, less a margin). */
  dailyLimit: number;
  /** Why the connection isn't working, in plain English. */
  error: string | null;
}

// ---------- Browser helper (Phase 10) ----------

export interface HelperTokenList {
  tokens: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
}
/** The code itself is only ever returned here, once. */
export interface HelperTokenCreated {
  id: string;
  label: string;
  token: string;
}
export interface HelperStatusResponse {
  email: string;
  /** Links waiting for a Google search. */
  pending: number;
  checkedToday: number;
}
export interface HelperClaimResponse {
  jobs: { id: string; url: string }[];
}

export interface IndexCheckFromScanResponse {
  id: string;
}
