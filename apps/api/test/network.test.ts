import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { describeNetwork } from '../src/services/network.ts';
import { makeApp, signedIn } from './helpers.ts';

const norm = (a: string | null | undefined) => (a ?? '').replace(/^::ffff:/i, '');

async function identity(hops: number, xff?: string) {
  const h = makeApp({ env: { HLCC_TRUST_PROXY: String(hops) } });
  const a = await signedIn(h);
  const req = a.agent.get('/api/v1/network');
  if (xff !== undefined) req.set('x-forwarded-for', xff);
  const res = await req;
  return { res, body: res.body as ReturnType<typeof describeNetwork> };
}

describe('network identity endpoint', () => {
  it('requires a session', async () => {
    const h = makeApp();
    expect((await request(h.app).get('/api/v1/network')).status).toBe(401);
  });

  it('predicts the address Express really uses for every hop count', async () => {
    const chains = [
      undefined,
      '203.0.113.7',
      '203.0.113.7, 10.0.0.2',
      '198.51.100.1, 203.0.113.7, 10.0.0.2',
      '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5',
    ];
    for (const xff of chains) {
      // What the server would offer, asked once on an app that trusts nothing.
      const { body: asked } = await identity(0, xff);
      for (let hops = 0; hops <= 3; hops++) {
        const { body: actual } = await identity(hops, xff);
        expect(norm(actual.clientAddress), `xff=${xff ?? '(none)'} hops=${hops}`).toBe(
          norm(asked.candidates[hops]!.address),
        );
      }
    }
  }, 60_000);

  it('reports what arrived, the configured count and candidates for 0 to 3 hops', async () => {
    const { body } = await identity(1, '203.0.113.7');
    expect(body.configuredHops).toBe(1);
    expect(body.forwardedFor).toEqual(['203.0.113.7']);
    expect(body.peerAddress).toBeTruthy();
    expect(body.candidates.map((c) => c.hops)).toEqual([0, 1, 2, 3]);
    expect(norm(body.candidates[0]!.address)).toBe(norm(body.peerAddress));
    expect(body.candidates[1]!.address).toBe('203.0.113.7');
    expect(norm(body.clientAddress)).toBe('203.0.113.7');
  });

  it('uses the peer when nothing is forwarded, whatever the hop count', async () => {
    const { body } = await identity(2);
    expect(body.forwardedFor).toEqual([]);
    expect(new Set(body.candidates.map((c) => norm(c.address))).size).toBe(1);
  });

  it('does not echo cookies, credentials or other headers', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const res = await a.agent
      .get('/api/v1/network')
      .set('x-api-key', 'topsecret-key-123')
      .set('authorization', 'Bearer topsecret-token-456');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/topsecret|hlcc_session|csrf/i);
    expect(Object.keys(res.body).sort()).toEqual([
      'candidates',
      'clientAddress',
      'configuredHops',
      'forwardedFor',
      'peerAddress',
    ]);
  });
});

describe('describeNetwork', () => {
  it('shows junk and oversized entries as invalid instead of passing them on', () => {
    const r = describeNetwork(
      '10.0.0.5',
      ['<script>alert(1)</script>, ' + 'a'.repeat(200) + ', 203.0.113.9'],
      0,
      '10.0.0.5',
    );
    expect(r.forwardedFor).toEqual(['(invalid)', '(invalid)', '203.0.113.9']);
    expect(JSON.stringify(r)).not.toContain('<script>');
  });

  it('limits the chain it reports', () => {
    const many = Array.from({ length: 40 }, (_, i) => `10.0.0.${i}`).join(', ');
    expect(describeNetwork('10.1.1.1', many, 0, '10.1.1.1').forwardedFor).toHaveLength(10);
  });

  it('strips the IPv4-mapped prefix for readability', () => {
    expect(describeNetwork('::ffff:172.18.0.5', '203.0.113.7', 1, '203.0.113.7').peerAddress).toBe(
      '172.18.0.5',
    );
  });

  it('resolves to the furthest address when there are fewer proxies than hops', () => {
    const r = describeNetwork('172.18.0.5', '203.0.113.7', 3, '203.0.113.7');
    expect(r.candidates.map((c) => c.address)).toEqual([
      '172.18.0.5',
      '203.0.113.7',
      '203.0.113.7',
      '203.0.113.7',
    ]);
  });

  it('handles a missing peer and header without throwing', () => {
    const r = describeNetwork(undefined, undefined, 0, undefined);
    expect(r.peerAddress).toBeNull();
    expect(r.clientAddress).toBeNull();
    expect(r.candidates.every((c) => c.address === '(unknown)')).toBe(true);
  });
});
