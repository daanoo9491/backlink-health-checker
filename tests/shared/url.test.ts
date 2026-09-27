import { describe, expect, it } from 'vitest';
import { checkUrl, isInternalHost } from '../../src/shared/url';

const ok = (v: string) => {
  const r = checkUrl(v);
  if (!r.ok) throw new Error(`expected ok for ${v}, got ${r.reason}`);
  return r;
};
const reason = (v: string) => {
  const r = checkUrl(v);
  return r.ok ? 'OK' : r.reason;
};

describe('checkUrl: accepts', () => {
  it('http and https links', () => {
    expect(ok('https://example.com/post').url).toBe('https://example.com/post');
    expect(ok('http://example.com').url).toBe('http://example.com/');
  });

  it('values with stray spaces, non-breaking spaces and quotes', () => {
    expect(ok('  https://example.com/a \u00a0').url).toBe('https://example.com/a');
    expect(ok('"https://example.com/a"').url).toBe('https://example.com/a');
    expect(ok('<https://example.com/a>').url).toBe('https://example.com/a');
    expect(ok('\u200bhttps://example.com/a').url).toBe('https://example.com/a');
  });

  it('www. addresses by adding https://, and says so', () => {
    const r = ok('www.example.com/listing');
    expect(r.url).toBe('https://www.example.com/listing');
    expect(r.addedScheme).toBe(true);
  });

  it('international domain names', () => {
    expect(ok('https://müller.de/seite').url).toBe('https://xn--mller-kva.de/seite');
  });
});

describe('checkUrl: rejects', () => {
  it.each([
    ['', 'NOT_A_URL'],
    ['not a link', 'NOT_A_URL'],
    ['example', 'NOT_A_URL'],
    ['example.com/page', 'NOT_A_URL'], // ambiguous without www. or scheme
    ['https://', 'NOT_A_URL'],
    ['http://intranet/page', 'NOT_A_URL'],
    ['https://exa mple.com', 'NOT_A_URL'],
    ['javascript:alert(1)', 'UNSUPPORTED_PROTOCOL'],
    ['ftp://files.example.com', 'UNSUPPORTED_PROTOCOL'],
    ['file:///etc/passwd', 'UNSUPPORTED_PROTOCOL'],
    ['data:text/html,hi', 'UNSUPPORTED_PROTOCOL'],
    ['mailto:a@b.com', 'UNSUPPORTED_PROTOCOL'],
    ['https://user:pass@example.com', 'HAS_CREDENTIALS'],
    ['http://localhost:8787', 'INTERNAL_ADDRESS'],
    ['http://127.0.0.1', 'INTERNAL_ADDRESS'],
    ['http://2130706433/', 'INTERNAL_ADDRESS'], // 127.0.0.1 as a single number
    ['http://0x7f.1/', 'INTERNAL_ADDRESS'],
    ['http://169.254.169.254/latest/meta-data', 'INTERNAL_ADDRESS'],
    ['http://10.0.0.5', 'INTERNAL_ADDRESS'],
    ['http://192.168.1.1', 'INTERNAL_ADDRESS'],
    ['http://172.20.0.1', 'INTERNAL_ADDRESS'],
    ['http://[::1]/', 'INTERNAL_ADDRESS'],
    ['http://[::ffff:127.0.0.1]/', 'INTERNAL_ADDRESS'],
    ['http://printer.local', 'INTERNAL_ADDRESS'],
    [`https://example.com/${'a'.repeat(2100)}`, 'TOO_LONG'],
  ])('%s -> %s', (value, expected) => {
    expect(reason(value)).toBe(expected);
  });
});

describe('normalisation for duplicate detection', () => {
  it('treats case of host, default ports, fragments and trailing dots as the same page', () => {
    const a = ok('https://Blog.Example.com/post-1').normalized;
    expect(ok('HTTPS://blog.example.com:443/post-1#comments').normalized).toBe(a);
    expect(ok('https://blog.example.com./post-1').normalized).toBe(a);
  });

  it('keeps differences that can change the page', () => {
    const base = ok('https://example.com/Post').normalized;
    expect(ok('https://example.com/post').normalized).not.toBe(base); // path case
    expect(ok('http://example.com/Post').normalized).not.toBe(base); // scheme
    expect(ok('https://example.com/Post?a=1').normalized).not.toBe(base); // query
  });
});

describe('isInternalHost', () => {
  it('allows public addresses', () => {
    expect(isInternalHost('example.com')).toBe(false);
    expect(isInternalHost('8.8.8.8')).toBe(false);
    expect(isInternalHost('172.32.0.1')).toBe(false);
  });
});
