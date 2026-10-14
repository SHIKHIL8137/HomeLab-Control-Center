// Container healthcheck for the proxy: an authenticated request to its own /_ping.
//   200  the proxy answered and Docker is reachable
//   502  the proxy answered and authenticated us, but Docker itself is down (restarting the proxy
//        would not help, and the dashboard reports Docker as unavailable on its own)
//   401  the credential does not match: this is a real misconfiguration, so it is unhealthy
import { readToken } from './server.ts';

const port = Number(process.env.PROXY_PORT ?? 2375);
try {
  const res = await fetch(`http://127.0.0.1:${port}/_ping`, {
    headers: { authorization: `Bearer ${readToken(process.env)}` },
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.status === 200 || res.status === 502 ? 0 : 1);
} catch {
  process.exit(1);
}
