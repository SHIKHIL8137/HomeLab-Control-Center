import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NetworkIdentity } from '@hlcc/shared';
import { NetworkCard, advise } from './NetworkCard';

const identity = (over: Partial<NetworkIdentity> = {}): NetworkIdentity => ({
  clientAddress: '203.0.113.7',
  peerAddress: '172.18.0.5',
  forwardedFor: ['203.0.113.7'],
  configuredHops: 1,
  candidates: [
    { hops: 0, address: '172.18.0.5' },
    { hops: 1, address: '203.0.113.7' },
    { hops: 2, address: '203.0.113.7' },
    { hops: 3, address: '203.0.113.7' },
  ],
  ...over,
});

describe('advice', () => {
  it('has nothing to flag for a sensible setup, but still asks you to confirm', () => {
    const a = advise(identity());
    expect(a).toHaveLength(1);
    expect(a[0]!.tone).toBe('ok');
    expect(a[0]!.text).toMatch(/real public address/);
  });

  it('flags a proxy that forwards while no proxy is trusted: everyone shares one address', () => {
    const a = advise(identity({ configuredHops: 0, clientAddress: '172.18.0.5' }));
    expect(a.some((x) => x.tone === 'bad' && /lock everyone out/.test(x.text))).toBe(true);
  });

  it('flags a private address in use, which is probably another proxy', () => {
    const a = advise(
      identity({ clientAddress: '10.0.0.2', forwardedFor: ['10.0.0.2', '172.18.0.9'] }),
    );
    expect(a.some((x) => /private one.*another proxy/.test(x.text))).toBe(true);
  });

  it('flags a hop count higher than the proxies that forwarded the request', () => {
    const a = advise(identity({ configuredHops: 3 }));
    expect(a.some((x) => /choose their own address/.test(x.text))).toBe(true);
  });

  it('notes a trusted proxy with no forwarded header, as with a direct local connection', () => {
    const a = advise(
      identity({ forwardedFor: [], clientAddress: '127.0.0.1', peerAddress: '127.0.0.1' }),
    );
    expect(a.some((x) => x.tone === 'warn' && /no forwarded address/.test(x.text))).toBe(true);
  });

  it('treats common private ranges as private and public addresses as public', () => {
    for (const priv of [
      '10.1.2.3',
      '192.168.1.5',
      '172.16.0.1',
      '172.31.9.9',
      '127.0.0.1',
      '169.254.1.1',
      'fd00::1',
    ]) {
      expect(
        advise(identity({ clientAddress: priv, forwardedFor: ['x1'] })).some((x) =>
          /private one/.test(x.text),
        ),
        priv,
      ).toBe(true);
    }
    for (const pub of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '172.15.0.1']) {
      expect(
        advise(identity({ clientAddress: pub })).some((x) => /private one/.test(x.text)),
        pub,
      ).toBe(false);
    }
  });
});

describe('NetworkCard', () => {
  it('shows what arrived and the address each hop count would use', () => {
    render(<NetworkCard n={identity()} />);
    expect(screen.getByText('Address in use for this browser').nextSibling).toHaveTextContent(
      '203.0.113.7',
    );
    expect(screen.getByText('Connected from (nearest proxy or you)').nextSibling).toHaveTextContent(
      '172.18.0.5',
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('1');
    expect(rows[1]).toHaveTextContent('current');
    expect(rows[0]).not.toHaveTextContent('current');
  });

  it('says it is evidence only and where the value is actually set', () => {
    render(<NetworkCard n={identity()} />);
    expect(screen.getByText(/smallest/)).toBeInTheDocument();
    expect(screen.getByText(/changes nothing/)).toBeInTheDocument();
  });

  it('shows an empty chain and unknown addresses without breaking', () => {
    render(
      <NetworkCard n={identity({ forwardedFor: [], clientAddress: null, peerAddress: null })} />,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getAllByText('unknown')).toHaveLength(2);
  });
});
