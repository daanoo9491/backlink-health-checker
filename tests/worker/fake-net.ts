import { vi } from 'vitest';

type Page =
  | {
      status: number;
      location?: string;
      html?: string | Uint8Array;
      contentType?: string;
      headers?: Record<string, string>;
    }
  | 'timeout'
  | 'reset';

/**
 * A tiny fake internet for checker tests. `dns` maps hostnames to IPs
 * (missing = domain doesn't exist); `pages` maps URLs to responses.
 */
export function fakeInternet(dns: Record<string, string[]>, pages: Record<string, Page>) {
  const requested: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);

    if (u.hostname === 'cloudflare-dns.com') {
      const name = u.searchParams.get('name')!;
      const type = u.searchParams.get('type');
      const ips = dns[name];
      if (!ips) return Response.json({ Status: 3 });
      const want = ips.filter((ip) => (type === 'AAAA' ? ip.includes(':') : !ip.includes(':')));
      return Response.json({ Status: 0, Answer: want.map((data) => ({ type: type === 'AAAA' ? 28 : 1, data })) });
    }

    requested.push(url);
    const page = pages[url];
    if (page === 'timeout') {
      return new Promise<Response>((_, reject) => {
        const s = init?.signal;
        s?.addEventListener('abort', () => reject(s.reason ?? new DOMException('Timeout', 'TimeoutError')));
      });
    }
    if (page === 'reset') throw new TypeError('Network connection lost.');
    if (!page) return new Response('not found', { status: 404 });
    const headers = new Headers(page.location ? { Location: page.location } : {});
    for (const [k, v] of Object.entries(page.headers ?? {})) headers.set(k, v);
    if (page.html !== undefined) {
      headers.set('Content-Type', page.contentType ?? 'text/html; charset=utf-8');
      return new Response(page.html, { status: page.status, headers });
    }
    if (page.contentType) headers.set('Content-Type', page.contentType);
    return new Response(page.status >= 300 && page.status < 400 ? null : 'body', { status: page.status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requested };
}
