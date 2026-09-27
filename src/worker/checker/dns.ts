/**
 * DNS check before connecting: resolves the hostname with DNS-over-HTTPS and
 * refuses private/local addresses (SSRF protection against names like
 * "evil.example" that resolve to 10.0.0.5 or 169.254.169.254).
 */
import { isInternalIp } from '../../shared/url';
import { BudgetExhausted, type SubrequestBudget } from './budget';

export type DnsVerdict =
  { ok: true; addresses: string[] } | { ok: false; reason: 'NOT_FOUND' | 'INTERNAL' | 'LOOKUP_FAILED' };

interface DohAnswer {
  type: number;
  data: string;
}
interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

const DOH = 'https://cloudflare-dns.com/dns-query';
const A = 1;
const AAAA = 28;

export type Resolver = (hostname: string, budget: SubrequestBudget) => Promise<DnsVerdict>;

async function query(name: string, type: 'A' | 'AAAA', budget: SubrequestBudget): Promise<DohResponse | null> {
  if (!budget.take()) throw new BudgetExhausted();
  try {
    const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as DohResponse;
  } catch {
    return null;
  }
}

/** Resolves once per hostname per batch. Fails closed: if DNS can't be checked, the link isn't fetched. */
export function createResolver(): Resolver {
  const cache = new Map<string, Promise<DnsVerdict>>();
  return (hostname, budget) => {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    let hit = cache.get(host);
    if (!hit) {
      hit = resolve(host, budget);
      cache.set(host, hit);
      // Don't remember a result that only failed because we ran out of budget.
      hit.catch(() => cache.delete(host));
    }
    return hit;
  };
}

async function resolve(host: string, budget: SubrequestBudget): Promise<DnsVerdict> {
  const [v4, v6] = await Promise.all([query(host, 'A', budget), query(host, 'AAAA', budget)]);
  if (!v4 && !v6) return { ok: false, reason: 'LOOKUP_FAILED' };
  const addresses = [...(v4?.Answer ?? []), ...(v6?.Answer ?? [])]
    .filter((a) => a.type === A || a.type === AAAA)
    .map((a) => a.data);
  if (addresses.some(isInternalIp)) return { ok: false, reason: 'INTERNAL' };
  if (addresses.length === 0) {
    // Status 3 = NXDOMAIN (the domain doesn't exist).
    return { ok: false, reason: v4?.Status === 3 || v6?.Status === 3 || (v4 && v6) ? 'NOT_FOUND' : 'LOOKUP_FAILED' };
  }
  return { ok: true, addresses };
}
