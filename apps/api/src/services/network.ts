import type { NetworkIdentity } from '@hlcc/shared';

const MAX_HOPS = 3;

/** Keeps only characters that can appear in an IP address; anything else is shown as invalid. */
const clean = (s: string): string =>
  /^[0-9A-Fa-f:.%]{1,64}$/.test(s) ? s.replace(/^::ffff:/i, '') : '(invalid)';

/**
 * Mirrors how Express resolves the client address for "trust proxy = N": starting from the
 * connection's peer, trust N hops, and take the first address beyond them. Fewer entries than hops
 * simply resolves to the furthest address available.
 */
export function describeNetwork(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  configuredHops: number,
  clientAddress: string | undefined,
): NetworkIdentity {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const chain = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(clean);
  const peerAddress = peer ? clean(peer) : null;
  // Nearest first: the peer, then the forwarded entries from the right-hand end.
  const nearestFirst = [...(peerAddress ? [peerAddress] : []), ...[...chain].reverse()];
  const candidates = Array.from({ length: MAX_HOPS + 1 }, (_, hops) => ({
    hops,
    address: nearestFirst[Math.min(hops, nearestFirst.length - 1)] ?? '(unknown)',
  }));
  return {
    clientAddress: clientAddress ? clean(clientAddress) : null,
    peerAddress,
    forwardedFor: chain,
    configuredHops,
    candidates,
  };
}
