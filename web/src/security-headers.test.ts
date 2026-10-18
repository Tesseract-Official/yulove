import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Header {
  key: string;
  value: string;
}
interface VercelConfig {
  headers: Array<{ source: string; headers: Header[] }>;
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const config = JSON.parse(read('../vercel.json')) as VercelConfig;

const everyPage = config.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
const header = (name: string) => everyPage.find((h) => h.key === name)?.value;

/** The sources of one CSP directive, e.g. directive('connect-src'). */
function directive(name: string): string[] {
  const policy = header('Content-Security-Policy') ?? '';
  const found = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  return found ? found.slice(1) : [];
}

describe('security headers on every page', () => {
  it('has the standard set', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('forces HTTPS for two years, including subdomains', () => {
    expect(header('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
  });

  it('allows the camera to this site only (photos are taken in the browser) and nothing else sensitive', () => {
    const policy = header('Permissions-Policy') ?? '';
    expect(policy).toContain('camera=(self)');
    for (const off of ['microphone', 'geolocation', 'payment', 'usb']) {
      expect(policy).toContain(`${off}=()`);
    }
  });
});

describe('Content-Security-Policy', () => {
  it('falls back to this site only', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
  });

  it('runs scripts from this site only: no inline script, no eval, no other host', () => {
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(header('Content-Security-Policy')).not.toMatch(
      /unsafe-eval|'unsafe-inline'.*script-src/,
    );
  });

  it('lets the app reach only its API, the Cognito sign-in domain and the photo bucket', () => {
    expect(directive('connect-src').sort()).toEqual(
      [
        "'self'",
        'https://*.auth.ap-south-1.amazoncognito.com',
        'https://*.execute-api.ap-south-1.amazonaws.com',
        'https://*.s3.ap-south-1.amazonaws.com',
      ].sort(),
    );
  });

  it('shows images from this site, the cropper (blob:) and the photo bucket', () => {
    expect(directive('img-src').sort()).toEqual(
      ["'self'", 'blob:', 'data:', 'https://*.s3.ap-south-1.amazonaws.com'].sort(),
    );
  });

  it('cannot be framed, cannot embed, and cannot change base or form targets', () => {
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('frame-src')).toEqual(["'none'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('form-action')).toEqual(["'self'"]);
  });

  it('uses the region the stacks are deployed in', () => {
    const hosts = [...directive('connect-src'), ...directive('img-src')].filter((s) =>
      s.startsWith('https://'),
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toContain('.ap-south-1.');
  });
});

describe('the page itself', () => {
  const html = read('../index.html');

  it('has no inline script and no inline event handler, which the policy would block', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect((body ?? '').trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('keeps config.json uncached', () => {
    const entry = config.headers.find((h) => h.source === '/config.json');
    expect(entry?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
  });
});
