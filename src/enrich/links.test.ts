import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  fetchPage,
  isBlockedAddress,
  isLoginWalled,
  stripHtml,
  titleFromPath,
} from './links.js';

describe('extractUrls', () => {
  it('finds http(s) URLs in order, distinct, at most three', () => {
    const body =
      'see https://a.example/x, then http://b.example/y. Again https://a.example/x and https://c.example/ plus https://d.example/';
    expect(extractUrls(body)).toEqual([
      'https://a.example/x',
      'http://b.example/y',
      'https://c.example/',
    ]);
  });

  it('trims trailing punctuation and closing brackets', () => {
    expect(extractUrls('(https://a.example/path).')).toEqual(['https://a.example/path']);
    expect(extractUrls('go https://a.example/?q=1&r=2! now')).toEqual([
      'https://a.example/?q=1&r=2',
    ]);
    expect(extractUrls('wiki https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('ignores other schemes and bare domains', () => {
    expect(extractUrls('ftp://x.example/file mailto:a@b.example example.com')).toEqual([]);
    expect(extractUrls(null)).toEqual([]);
  });
});

describe('isLoginWalled', () => {
  it('matches the social hosts and their subdomains only', () => {
    expect(isLoginWalled('https://www.instagram.com/p/abc/')).toBe(true);
    expect(isLoginWalled('https://m.facebook.com/x')).toBe(true);
    expect(isLoginWalled('https://fb.com/x')).toBe(true);
    expect(isLoginWalled('https://x.com/user/status/1')).toBe(true);
    expect(isLoginWalled('https://twitter.com/user')).toBe(true);
    expect(isLoginWalled('https://vm.tiktok.com/abc')).toBe(true);
    expect(isLoginWalled('https://www.linkedin.com/in/x')).toBe(true);
    expect(isLoginWalled('https://notx.com/')).toBe(false);
    expect(isLoginWalled('https://example.com/facebook.com')).toBe(false);
    expect(isLoginWalled('not a url')).toBe(false);
  });
});

describe('stripHtml', () => {
  const page = `<!doctype html><html><head>
    <title> My &amp; Page </title>
    <meta property="og:description" content="OG text here">
    <meta content="Meta &quot;description&quot;" name="description">
    <style>body{color:red}</style>
    <script>alert('x')</script>
    </head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <header>Site header</header>
    <h1>Welcome</h1>
    <p>First   paragraph&nbsp;with <b>bold</b> &#39;quotes&#39; &#x41;.</p>
    <!-- a comment -->
    <footer>Footer stuff</footer>
    </body></html>`;

  it('extracts title, meta description and visible text', () => {
    const r = stripHtml(page);
    expect(r.title).toBe('My & Page');
    expect(r.description).toBe('Meta "description"');
    expect(r.text).toBe("Welcome First paragraph with bold 'quotes' A.");
  });

  it('falls back to og:description and caps the text', () => {
    const long = `<title>T</title><meta property="og:description" content="OG only"><p>${'word '.repeat(1000)}</p>`;
    const r = stripHtml(long, 100);
    expect(r.description).toBe('OG only');
    expect(r.text.length).toBeLessThanOrEqual(100);
  });

  it('handles plain text and empty input', () => {
    expect(stripHtml('just text\n\nmore')).toEqual({
      title: null,
      description: null,
      text: 'just text more',
    });
    expect(stripHtml('')).toEqual({ title: null, description: null, text: '' });
  });
});

describe('titleFromPath', () => {
  it('guesses a title from the last path segment', () => {
    expect(titleFromPath('https://x.example/files/quarterly-report_v2.pdf')).toBe(
      'quarterly report v2.pdf',
    );
    expect(titleFromPath('https://x.example/')).toBe('x.example');
    expect(titleFromPath('nope')).toBeNull();
  });
});

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local and unique-local ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('fetchPage', () => {
  type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
  const html = (body: string, init: ResponseInit = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });
  const deps = (handler: Handler, hosts: Record<string, string[]> = {}) => ({
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init ?? {})) as unknown as typeof fetch,
    resolveHost: async (host: string) => hosts[host] ?? ['93.184.216.34'],
  });

  it('returns the final URL, content type and body', async () => {
    const r = await fetchPage(
      'https://a.example/p',
      deps(() => html('<title>A</title>')),
    );
    expect(r.ok && r.value).toEqual({
      finalUrl: 'https://a.example/p',
      contentType: 'text/html',
      body: '<title>A</title>',
    });
  });

  it('sends a browser-like user agent and an HTML accept header, no redirects followed by fetch', async () => {
    let seen: RequestInit | undefined;
    await fetchPage(
      'https://a.example/',
      deps((_u, init) => {
        seen = init;
        return html('x');
      }),
    );
    const headers = seen?.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/Mozilla/);
    expect(headers.accept).toContain('text/html');
    expect(seen?.redirect).toBe('manual');
  });

  it('follows redirects up to the limit, checking every hop', async () => {
    const calls: string[] = [];
    const handler: Handler = (url) => {
      calls.push(url);
      if (url === 'https://a.example/1')
        return new Response(null, { status: 302, headers: { location: '/2' } });
      if (url === 'https://a.example/2')
        return new Response(null, { status: 301, headers: { location: 'https://b.example/3' } });
      return html('done');
    };
    const r = await fetchPage('https://a.example/1', deps(handler), { maxRedirects: 5 });
    expect(r.ok && r.value.finalUrl).toBe('https://b.example/3');
    expect(calls).toEqual(['https://a.example/1', 'https://a.example/2', 'https://b.example/3']);

    const tooMany = await fetchPage('https://a.example/1', deps(handler), { maxRedirects: 1 });
    expect(!tooMany.ok && tooMany.error.tag).toBe('fetch');
  });

  it('refuses hosts that resolve to private addresses, including after a redirect', async () => {
    const hosts = { 'internal.example': ['10.1.2.3'], 'a.example': ['93.184.216.34'] };
    const direct = await fetchPage(
      'https://internal.example/',
      deps(() => html('secret'), hosts),
    );
    expect(!direct.ok && direct.error.tag).toBe('blocked-address');

    const viaRedirect = await fetchPage(
      'https://a.example/',
      deps(
        (url) =>
          url === 'https://a.example/'
            ? new Response(null, { status: 302, headers: { location: 'http://internal.example/' } })
            : html('secret'),
        hosts,
      ),
    );
    expect(!viaRedirect.ok && viaRedirect.error.tag).toBe('blocked-address');

    const literal = await fetchPage(
      'http://127.0.0.1:8787/api/status',
      deps(() => html('x')),
    );
    expect(!literal.ok && literal.error.tag).toBe('blocked-address');
    const local = await fetchPage(
      'http://localhost/',
      deps(() => html('x')),
    );
    expect(!local.ok && local.error.tag).toBe('blocked-address');
  });

  it('caps the body size', async () => {
    const big = 'a'.repeat(5000);
    const r = await fetchPage(
      'https://a.example/',
      deps(() => html(big)),
      { maxBytes: 1000 },
    );
    expect(r.ok && r.value.body.length).toBe(1000);
  });

  it('reports non-HTML content and HTTP errors', async () => {
    const pdf = await fetchPage(
      'https://a.example/f.pdf',
      deps(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })),
    );
    expect(pdf.ok && pdf.value.contentType).toBe('application/pdf');
    expect(pdf.ok && pdf.value.body).toBe('');

    const gone = await fetchPage(
      'https://a.example/',
      deps(() => html('', { status: 404 })),
    );
    expect(!gone.ok && gone.error.tag === 'fetch' && gone.error.message).toContain('404');

    const thrown = await fetchPage(
      'https://a.example/',
      deps(() => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(!thrown.ok && thrown.error.tag === 'fetch' && thrown.error.message).toContain(
      'ECONNRESET',
    );
  });
});
