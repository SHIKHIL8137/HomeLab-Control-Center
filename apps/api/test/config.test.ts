import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readSecret } from '../src/config.ts';
import { effectivePort, guardedGet, isBlockedPort, validateTarget } from '../src/security/ssrf.ts';

const TOKEN = 'test-only-docker-token-0123456789abcdef0123456789';
const SECURE = { HLCC_COOKIE_SECURE: 'true' };

function secretFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hlcc-secret-'));
  const file = join(dir, 'secret');
  writeFileSync(file, content);
  return file;
}

describe('the Docker proxy credential fails closed', () => {
  it('refuses a proxy URL with no credential, and says which variable is missing', () => {
    expect(() => loadConfig({ HLCC_DOCKER_URL: 'http://docker-proxy:2375' })).toThrow(
      /HLCC_DOCKER_TOKEN/,
    );
  });

  it('refuses weak or malformed credentials without echoing them', () => {
    for (const bad of [
      'short',
      'a'.repeat(31),
      `${TOKEN} with spaces`,
      `${TOKEN}\n${TOKEN}`,
      'é'.repeat(40),
    ]) {
      let message = '';
      try {
        loadConfig({ HLCC_DOCKER_URL: 'http://docker-proxy:2375', HLCC_DOCKER_TOKEN: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(bad)).toMatch(/at least 32/);
      expect(message).not.toContain(
        bad.trim().slice(0, 8) === '' ? 'zzz' : bad.trim().slice(0, 12),
      );
    }
  });

  it('refuses a long but trivially guessable credential, without echoing it', () => {
    for (const weak of ['a'.repeat(64), 'ab'.repeat(32), '1'.repeat(40)]) {
      let message = '';
      try {
        loadConfig({ HLCC_DOCKER_URL: 'http://docker-proxy:2375', HLCC_DOCKER_TOKEN: weak });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, weak.slice(0, 8)).toMatch(/repetitive/);
      expect(message).not.toContain(weak);
    }
  });

  it('accepts a strong credential from the environment or from a file', () => {
    const env = { HLCC_DOCKER_URL: 'http://docker-proxy:2375' };
    expect(loadConfig({ ...env, HLCC_DOCKER_TOKEN: TOKEN }).dockerToken).toBe(TOKEN);
    expect(
      loadConfig({ ...env, HLCC_DOCKER_TOKEN_FILE: secretFile(`${TOKEN}\n`) }).dockerToken,
    ).toBe(TOKEN);
  });

  it('refuses two sources at once, an unreadable file, and an empty file', () => {
    const env = { HLCC_DOCKER_URL: 'http://docker-proxy:2375' };
    expect(() =>
      loadConfig({ ...env, HLCC_DOCKER_TOKEN: TOKEN, HLCC_DOCKER_TOKEN_FILE: secretFile(TOKEN) }),
    ).toThrow(/only one of/);
    expect(() =>
      loadConfig({ ...env, HLCC_DOCKER_TOKEN_FILE: '/nonexistent/path/secret' }),
    ).toThrow(/could not be read/);
    expect(() => loadConfig({ ...env, HLCC_DOCKER_TOKEN_FILE: secretFile('  \n') })).toThrow(
      /HLCC_DOCKER_TOKEN/,
    );
  });

  it('does not require a credential when Docker is not configured', () => {
    expect(loadConfig({}).dockerToken).toBeUndefined();
    expect(loadConfig({ HLCC_DOCKER_URL: '', HLCC_DOCKER_TOKEN: '' }).dockerUrl).toBeUndefined();
  });

  it('keeps the credential out of every error message', () => {
    for (const env of [
      { HLCC_DOCKER_URL: 'ftp://x', HLCC_DOCKER_TOKEN: TOKEN },
      { HLCC_DOCKER_URL: 'http://u:p@x:1', HLCC_DOCKER_TOKEN: TOKEN },
      { HLCC_DOCKER_URL: 'http://x:1', HLCC_DOCKER_TOKEN: TOKEN, HLCC_DOCKER_TOKEN_FILE: '/x' },
      { HLCC_DOCKER_URL: 'http://x:1', HLCC_DOCKER_TOKEN: TOKEN, HLCC_MODE: 'bogus' },
    ]) {
      try {
        loadConfig(env);
        throw new Error('expected a failure');
      } catch (e) {
        expect((e as Error).message).not.toContain(TOKEN);
      }
    }
  });
});

describe('setup token handling', () => {
  it('reads it from a file, trims it, and rejects a short one without leaking it', () => {
    expect(
      loadConfig({ HLCC_SETUP_TOKEN_FILE: secretFile('a-sixteen-char-token\n') }).setupToken,
    ).toBe('a-sixteen-char-token');
    let message = '';
    try {
      loadConfig({ HLCC_SETUP_TOKEN_FILE: secretFile('tooshort-secret') });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/at least 16/);
    expect(message).not.toContain('tooshort-secret');
  });

  it('treats an empty value, as Compose passes it, as not set', () => {
    expect(
      loadConfig({ HLCC_SETUP_TOKEN: '', HLCC_SETUP_TOKEN_FILE: '' }).setupToken,
    ).toBeUndefined();
  });

  it('readSecret never includes a value in its errors', () => {
    expect(() => readSecret({ X: 'v', X_FILE: '/f' }, 'X')).toThrow('Set only one of X and X_FILE');
  });
});

describe('production refuses insecure defaults', () => {
  it('requires Secure cookies unless the risk is accepted explicitly', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/HLCC_COOKIE_SECURE/);
    expect(loadConfig({ NODE_ENV: 'production', ...SECURE }).cookieSecure).toBe(true);
    const accepted = loadConfig({ NODE_ENV: 'production', HLCC_ALLOW_INSECURE_COOKIES: 'true' });
    expect(accepted.production).toBe(true);
    expect(accepted.cookieSecure).toBe(false);
  });

  it('does not nag in development', () => {
    expect(loadConfig({}).production).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development' }).cookieSecure).toBe(false);
  });
});

describe('proxy trust and polling limits', () => {
  it('trusts a fixed number of proxy hops, never "everything"', () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ HLCC_TRUST_PROXY: 'false' }).trustProxy).toBe(0);
    expect(loadConfig({ HLCC_TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(loadConfig({ HLCC_TRUST_PROXY: '2' }).trustProxy).toBe(2);
    for (const bad of ['4', '-1', '1.5', 'yes', '99']) {
      expect(() => loadConfig({ HLCC_TRUST_PROXY: bad }), bad).toThrow();
    }
  });

  it('keeps Docker polling from being set absurdly fast', () => {
    expect(() => loadConfig({ HLCC_POLL_INTERVAL_MS: '4999' })).toThrow();
    expect(() => loadConfig({ HLCC_POLL_INTERVAL_MS: '1000' })).toThrow();
    expect(loadConfig({ HLCC_POLL_INTERVAL_MS: '5000' }).pollIntervalMs).toBe(5000);
  });

  it('exposes safe defaults for the new settings', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.mode).toBe('mock');
    expect(c.healthConcurrency).toBe(3);
    expect(c.sessionTtlMs).toBe(12 * 3_600_000);
  });
});

describe('SSRF: ports and spellings', () => {
  it('knows which port a URL really uses', () => {
    expect(effectivePort(new URL('http://x/'))).toBe(80);
    expect(effectivePort(new URL('https://x/'))).toBe(443);
    expect(effectivePort(new URL('http://x:8080/'))).toBe(8080);
    expect(effectivePort(new URL('http://x:80/'))).toBe(80);
  });

  it.each([
    22, 23, 25, 110, 143, 445, 1433, 2375, 2376, 3306, 3389, 5432, 6379, 9200, 11211, 27017,
  ])('never allows port %i, for public or private targets', (port) => {
    expect(isBlockedPort(port)).toBe(true);
    for (const host of ['example.com', '192.168.1.5', '127.0.0.1', '[::1]']) {
      expect(validateTarget(`http://${host}:${port}/`, true).ok, `${host}:${port}`).toBe(false);
    }
  });

  it('allows ordinary web ports', () => {
    for (const u of [
      'https://example.com/',
      'http://example.com:80/',
      'https://example.com:8443/h',
      'http://192.168.1.5:8080/',
    ]) {
      expect(validateTarget(u, true).ok, u).toBe(true);
    }
    expect(isBlockedPort(19999)).toBe(false); // Netdata
  });

  it('refuses a blocked port at connection time too, without connecting', async () => {
    for (const u of [
      'http://127.0.0.1:22/',
      'http://127.0.0.1:2375/',
      'https://example.com:5432/',
    ]) {
      expect((await guardedGet(u, { allowPrivate: true, timeoutMs: 300 })).failure, u).toBe(
        'blocked',
      );
    }
  });

  it('treats a trailing dot and any letter case as the same host', () => {
    for (const u of [
      'http://localhost./',
      'http://LOCALHOST/',
      'http://LocalHost./',
      'http://app.localhost./',
      'http://127.0.0.1./',
      'http://[::1]/',
    ]) {
      expect(validateTarget(u, false).ok, u).toBe(false);
    }
  });
});
