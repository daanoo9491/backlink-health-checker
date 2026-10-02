/**
 * The two Search Console calls the app makes: list the properties the
 * service account can see, and inspect one URL in one property.
 * Fixed Google hosts only, so the link checker's SSRF checks aren't needed.
 */
import { BudgetExhausted, type SubrequestBudget } from '../checker/budget';
import { GscError } from './auth';

const API = 'https://searchconsole.googleapis.com';

export interface GscProperty {
  /** "https://www.example.com/" (URL-prefix property) or "sc-domain:example.com" (domain property). */
  siteUrl: string;
  permissionLevel: 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser' | string;
}

/** The subset of Google's IndexStatusInspectionResult the app uses. */
export interface IndexStatusResult {
  verdict?: 'VERDICT_UNSPECIFIED' | 'PASS' | 'PARTIAL' | 'FAIL' | 'NEUTRAL' | string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
}

async function call<T>(token: string, path: string, init: RequestInit, budget?: SubrequestBudget): Promise<T> {
  if (budget && !budget.take()) throw new BudgetExhausted();
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GscError('Couldn’t reach Search Console.');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    const why =
      res.status === 429
        ? 'Search Console’s usage limit was reached; try again later.'
        : res.status === 403
          ? 'The service account has no access to this Search Console property.'
          : res.status === 401
            ? 'Search Console sign-in expired.'
            : `Search Console answered HTTP ${res.status}.`;
    throw new GscError(why, res.status);
  }
  return body;
}

export async function listProperties(token: string, budget?: SubrequestBudget): Promise<GscProperty[]> {
  const r = await call<{ siteEntry?: GscProperty[] }>(token, '/webmasters/v3/sites', { method: 'GET' }, budget);
  // "Unverified" means no access to its data.
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

export async function inspectUrl(
  token: string,
  inspectionUrl: string,
  siteUrl: string,
  budget?: SubrequestBudget,
): Promise<IndexStatusResult> {
  const r = await call<{ inspectionResult?: { indexStatusResult?: IndexStatusResult } }>(
    token,
    '/v1/urlInspection/index:inspect',
    { method: 'POST', body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'en-GB' }) },
    budget,
  );
  const result = r.inspectionResult?.indexStatusResult;
  if (!result) throw new GscError('Search Console returned no index status for this URL.');
  return result;
}
