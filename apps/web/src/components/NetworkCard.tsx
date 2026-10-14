import type { NetworkIdentity } from '@hlcc/shared';
import { Card, Pill } from './ui';

const PRIVATE =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
const isPrivate = (a: string) => PRIVATE.test(a);

export interface Advice {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

/** Plain-language reading of the evidence; it never claims to know the administrator's real address. */
export function advise(n: NetworkIdentity): Advice[] {
  const out: Advice[] = [];
  const used = n.clientAddress ?? '';
  if (n.configuredHops === 0 && n.forwardedFor.length > 0) {
    out.push({
      tone: 'bad',
      text: 'Requests are arriving through a proxy but no proxy is trusted. Every visitor looks like the proxy, so one person’s failed sign-ins can lock everyone out. Raise the hop count (see the table).',
    });
  }
  if (n.configuredHops > 0 && n.forwardedFor.length === 0) {
    out.push({
      tone: 'warn',
      text: 'A proxy is trusted but this request carried no forwarded address (for example you connected directly). That is fine locally; check again through the tunnel.',
    });
  }
  if (n.forwardedFor.length > 0 && used && isPrivate(used)) {
    out.push({
      tone: 'warn',
      text: 'The address in use is a private one, which is probably another proxy rather than you. Try the next hop count.',
    });
  }
  if (
    n.configuredHops > 0 &&
    n.forwardedFor.length > 0 &&
    n.configuredHops > n.forwardedFor.length
  ) {
    out.push({
      tone: 'warn',
      text: 'The hop count is higher than the number of proxies that forwarded this request. Too high lets visitors choose their own address by sending an X-Forwarded-For header.',
    });
  }
  if (out.length === 0) {
    out.push({
      tone: 'ok',
      text: 'Nothing looks wrong. Confirm the address in use is your real public address (search “what is my IP” from this same browser).',
    });
  }
  return out;
}

export function NetworkCard({ n }: { n: NetworkIdentity }) {
  return (
    <Card title="Network identity (choosing HLCC_TRUST_PROXY)" className="md:col-span-2">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Address in use for this browser</dt>
          <dd className="font-mono">{n.clientAddress ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="text-muted">Connected from (nearest proxy or you)</dt>
          <dd className="font-mono">{n.peerAddress ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="text-muted">Forwarded-for chain received</dt>
          <dd className="font-mono">
            {n.forwardedFor.length ? n.forwardedFor.join(', ') : 'none'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Configured hop count</dt>
          <dd>{n.configuredHops}</dd>
        </div>
      </dl>

      <table className="mt-3 w-full max-w-md text-left text-sm">
        <caption className="sr-only">Address that each hop count would use</caption>
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Hop count
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Address it would use
            </th>
            <th scope="col" className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {n.candidates.map((c) => (
            <tr key={c.hops}>
              <th scope="row" className="py-1 pr-3 font-medium">
                {c.hops}
              </th>
              <td className="py-1 pr-3 font-mono">{c.address}</td>
              <td className="py-1">
                {c.hops === n.configuredHops && <Pill tone="muted">current</Pill>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="mt-3 space-y-1 text-sm">
        {advise(n).map((a) => (
          <li key={a.text} className="flex gap-2">
            <Pill tone={a.tone}>
              {a.tone === 'ok' ? 'OK' : a.tone === 'warn' ? 'Check' : 'Fix'}
            </Pill>
            <span>{a.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Choose the <strong>smallest</strong> hop count whose address is your real public address.
        Set it in the server configuration, not here; this page only shows evidence and changes
        nothing.
      </p>
    </Card>
  );
}
