import { describe, expect, it } from 'vitest';
import { classifyResponse, isSamePageRedirect } from '../../src/worker/checker/classify';

const U = 'https://blog.example.com/post';
const s = (http: number, final = U) => classifyResponse(http, U, final).status;

describe('classifyResponse', () => {
  it('200 on the same address is Active', () => {
    expect(classifyResponse(200, U, U)).toEqual({ status: 'ACTIVE', reason: 'HTTP 200 OK' });
    expect(s(204)).toBe('ACTIVE');
  });

  it('404 and 410 are Dead, including after a redirect', () => {
    expect(s(404)).toBe('DEAD');
    expect(s(410)).toBe('DEAD');
    expect(classifyResponse(404, U, 'https://blog.example.com/missing').reason).toMatch(/Redirects to a missing page/);
  });

  it('temporary and ambiguous answers are never Dead', () => {
    expect(s(403)).toBe('BLOCKED');
    expect(s(401)).toBe('BLOCKED');
    expect(s(451)).toBe('BLOCKED');
    expect(s(400)).toBe('BLOCKED');
    expect(s(405)).toBe('BLOCKED');
    expect(s(429)).toBe('RATE_LIMITED');
    expect(s(408)).toBe('TIMEOUT');
    for (const c of [500, 502, 503, 504, 520, 522, 525]) expect(s(c)).toBe('SERVER_ERROR');
  });

  it('a redirect to a different page is Redirected (not Dead)', () => {
    expect(s(200, 'https://blog.example.com/')).toBe('REDIRECTED');
    expect(s(200, 'https://other.example.org/post')).toBe('REDIRECTED');
  });

  it('a redirect to the same page (https, www, trailing slash) stays Active', () => {
    expect(s(200, 'https://www.blog.example.com/post/')).toBe('ACTIVE');
    expect(classifyResponse(200, 'http://example.com/a', 'https://example.com/a').status).toBe('ACTIVE');
  });
});

describe('isSamePageRedirect', () => {
  it('ignores scheme, www and trailing slash only', () => {
    expect(isSamePageRedirect('http://example.com/a', 'https://www.example.com/a/')).toBe(true);
    expect(isSamePageRedirect('https://example.com/a', 'https://example.com/b')).toBe(false);
    expect(isSamePageRedirect('https://example.com/a?x=1', 'https://example.com/a')).toBe(false);
    expect(isSamePageRedirect('https://a.example.com/p', 'https://b.example.com/p')).toBe(false);
  });
});
